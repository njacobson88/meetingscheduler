// server.js
const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3001;

// Fixed Eastern Time Zone for 9-5 business hours
const BUSINESS_TIMEZONE = 'America/New_York';

// Debug logs for the file system (optional)
console.log("=== DEBUGGING FILE SYSTEM ===");
console.log("Current working directory:", process.cwd());
console.log("__dirname:", __dirname);
console.log("=== END DEBUGGING ===");

app.use(cors());
app.use(express.json());

// ----------------------------------------------
//  OAUTH & TOKEN LOGIC (UNCHANGED)
// ----------------------------------------------
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URL
);

let adminTokens = null;

// In production, load tokens from environment variables
if (process.env.GOOGLE_REFRESH_TOKEN) {
  adminTokens = {
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    access_token: process.env.GOOGLE_ACCESS_TOKEN || "",
    expiry_date: parseInt(process.env.TOKEN_EXPIRY_DATE || "0")
  };
  console.log('Loaded tokens from environment variables');
} else {
  // In development, try loading from tokens.json
  try {
    if (fs.existsSync('./tokens.json')) {
      const tokensData = fs.readFileSync('./tokens.json', 'utf8');
      adminTokens = JSON.parse(tokensData);
      console.log('Loaded tokens from file');
    }
  } catch (error) {
    console.error('Error loading tokens from file:', error);
  }
}

function saveTokensToFile(tokens) {
  try {
    if (process.env.NODE_ENV !== 'production') {
      fs.writeFileSync('./tokens.json', JSON.stringify(tokens));
      console.log('Tokens saved to file');
    } else {
      // In production, you'd store these securely or set them as env vars
      console.log('IMPORTANT - Save this as GOOGLE_REFRESH_TOKEN:', tokens.refresh_token);
      console.log('IMPORTANT - Save this as GOOGLE_ACCESS_TOKEN:', tokens.access_token);
      console.log('IMPORTANT - Save this as TOKEN_EXPIRY_DATE:', tokens.expiry_date);
    }
  } catch (error) {
    console.error('Error saving tokens:', error);
  }
}

app.get('/auth/admin', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    adminTokens = tokens;
    saveTokensToFile(tokens);
    res.send('Authentication successful! You can close this window.');
  } catch (error) {
    console.error('Error authenticating:', error);
    res.status(500).send('Authentication failed');
  }
});

async function ensureValidTokens() {
  if (!adminTokens) {
    throw new Error('Admin not authenticated. Visit /auth/admin first.');
  }
  // Check if token is expired and refresh if needed
  if (adminTokens.expiry_date && adminTokens.expiry_date < Date.now()) {
    console.log('Token expired, refreshing...');
    oauth2Client.setCredentials(adminTokens);
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      adminTokens = credentials;
      saveTokensToFile(adminTokens);
    } catch (error) {
      console.error('Error refreshing token:', error);
      throw new Error('Failed to refresh token. Re-authenticate via /auth/admin.');
    }
  }
  oauth2Client.setCredentials(adminTokens);
}

function getCalendarClient() {
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

async function findWorkCalendar() {
  try {
    await ensureValidTokens();
    const calendar = getCalendarClient();
    const calListResponse = await calendar.calendarList.list();
    const calendars = calListResponse.data.items;
    console.log("Available calendars:", calendars.map(c => c.summary));

    let calendarId = 'primary';
    const possibleNames = ['Work', 'Main', 'Primary', 'Default', process.env.CALENDAR_NAME];
    for (const name of possibleNames) {
      if (!name) continue;
      const found = calendars.find(cal =>
        cal.summary === name ||
        cal.summary.toLowerCase().includes(name.toLowerCase())
      );
      if (found) {
        calendarId = found.id;
        console.log(`Using calendar: ${found.summary} (${calendarId})`);
        break;
      }
    }
    return calendarId;
  } catch (error) {
    console.error('Error finding work calendar:', error);
    return 'primary';
  }
}

// ----------------------------------------------
//  HEALTH CHECK & AUTH STATUS
// ----------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

app.get('/api/check-admin-auth', (req, res) => {
  if (adminTokens) {
    res.status(200).json({ authenticated: true });
  } else {
    res.status(200).json({ authenticated: false });
  }
});

// ----------------------------------------------
//  MONTH AVAILABILITY (9-5 EST only)
// ----------------------------------------------
app.get('/api/month-availability', async (req, res) => {
  const { year, month, timezone } = req.query;
  if (!year || !month) {
    return res.status(400).send('Year and month parameters are required');
  }

  // Store the user's timezone for display purposes
  const userTimezone = timezone || BUSINESS_TIMEZONE;

  try {
    await ensureValidTokens();
    const calendar = getCalendarClient();

    // Create date range for the month
    const yearNum = parseInt(year, 10);
    const monthNum = parseInt(month, 10) - 1; // JS months are 0-indexed
    
    console.log(`Finding availability for ${year}-${month} (${yearNum}-${monthNum+1}), timezone: ${BUSINESS_TIMEZONE}`);

    const calendarId = await findWorkCalendar();

    // Get all events for the month
    const startOfMonth = new Date(Date.UTC(yearNum, monthNum, 1));
    const endOfMonth = new Date(Date.UTC(yearNum, monthNum + 1, 0, 23, 59, 59));
    
    console.log(`Querying calendar from ${startOfMonth.toISOString()} to ${endOfMonth.toISOString()}`);
    
    // Query Google Calendar for the entire month
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: startOfMonth.toISOString(),
      timeMax: endOfMonth.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500,
      timeZone: BUSINESS_TIMEZONE  // Always query in Eastern Time
    });

    const events = response.data.items.filter(event =>
      event.status !== 'cancelled' &&
      (!event.transparency || event.transparency !== 'transparent')
    );

    console.log(`Found ${events.length} total events for the month`);

    // For each day in the month, check if there's at least one available slot (9-5 Eastern)
    const daysInMonth = new Date(yearNum, monthNum + 1, 0).getDate();
    const availability = {};

    for (let day = 1; day <= daysInMonth; day++) {
      // Create the date string in YYYY-MM-DD format (using UTC to avoid timezone issues)
      const dateStr = new Date(Date.UTC(yearNum, monthNum, day))
        .toISOString()
        .split('T')[0];
      
      // Check if the day is a weekend (0 = Sunday, 6 = Saturday)
      const currentDate = new Date(Date.UTC(yearNum, monthNum, day));
      const dayOfWeek = currentDate.getDay();
      
      // Skip weekends - no availability on weekends
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        availability[dateStr] = false; // No availability on weekends
        console.log(`Day ${dateStr} is a weekend (day ${dayOfWeek}). No availability.`);
        continue; // Skip to next day
      }
      
      // Filter events for this specific day - CHECK FROM 8 AM to catch early meetings
      const queryStart = new Date(Date.UTC(yearNum, monthNum, day, 13, 0, 0)); // 8AM ET
      const queryEnd = new Date(Date.UTC(yearNum, monthNum, day, 22, 0, 0));   // 5PM ET
      
      const dayEvents = events.filter(event => {
        if (!event.start.dateTime || !event.end.dateTime) return false;
        
        const eventStart = new Date(event.start.dateTime);
        const eventEnd = new Date(event.end.dateTime);
        
        // Check if event is on this day and within our time range (8AM-5PM)
        return (
          (eventStart >= queryStart && eventStart < queryEnd) ||
          (eventEnd > queryStart && eventEnd <= queryEnd) ||
          (eventStart <= queryStart && eventEnd >= queryEnd)
        );
      });

      console.log(`Day ${dateStr}: Found ${dayEvents.length} events (8AM-5PM Eastern)`);
      
      // Calculate available slots for this day during business hours (9AM-5PM)
      const slotsStart = new Date(Date.UTC(yearNum, monthNum, day, 14, 0, 0)); // 9AM ET
      const slotsEnd = new Date(Date.UTC(yearNum, monthNum, day, 22, 0, 0));   // 5PM ET
      
      const availableSlots = calculateAdjacentSlots(dayEvents, slotsStart, slotsEnd);
      availability[dateStr] = availableSlots.length > 0;
    }

    res.json(availability);
  } catch (error) {
    console.error('Error fetching month availability:', error);
    res.status(500).send(error.message || 'Failed to fetch month availability');
  }
});

// ----------------------------------------------
//  DAY AVAILABILITY (9-5 EST only)
// ----------------------------------------------
// Helper function to check if a date is during Eastern Daylight Time (EDT)
function isEasternTimeDST(dateStr) {
  // Parse the date (using noon UTC to avoid any boundary issues)
  const date = new Date(dateStr + 'T12:00:00Z');
  const year = date.getUTCFullYear();
  
  // DST starts at 2:00 AM ET on the second Sunday of March
  let marchSecondSunday = new Date(Date.UTC(year, 2, 1)); // March 1
  marchSecondSunday.setUTCDate(marchSecondSunday.getUTCDate() + (7 - marchSecondSunday.getUTCDay()) % 7 + 7);
  
  // DST ends at 2:00 AM ET on the first Sunday of November
  let novemberFirstSunday = new Date(Date.UTC(year, 10, 1)); // November 1
  novemberFirstSunday.setUTCDate(novemberFirstSunday.getUTCDate() + (7 - novemberFirstSunday.getUTCDay()) % 7);
  
  // Check if the date falls within the DST period
  return date >= marchSecondSunday && date < novemberFirstSunday;
}

// Updated /api/available-slots endpoint with DST handling & Correct All-Day Event Processing
app.get('/api/available-slots', async (req, res) => {
  const { date, timezone } = req.query;
  if (!date) {
    return res.status(400).send('Date parameter is required');
  }
  const userTimezone = timezone || BUSINESS_TIMEZONE;

  try {
    await ensureValidTokens();
    const calendar = getCalendarClient();

    console.log(`Request for available slots on ${date} in ${userTimezone}`);

    // Parse date components
    const [yearStr, monthStr, dayStr] = date.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10) - 1; // JS months are 0-indexed
    const day = parseInt(dayStr, 10);

    // The specific date being queried (at UTC midnight)
    const selectedDateUTC = new Date(Date.UTC(year, month, day));

    // Check if the selected date is a weekend (0 = Sunday, 6 = Saturday)
    const dayOfWeek = selectedDateUTC.getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) { // [cite: 1649]
      console.log(`Selected date ${date} is a weekend (day ${dayOfWeek}). No bookings allowed.`); // [cite: 1650]
      return res.json([]); // Return empty array for weekends // [cite: 1650]
    }

    // Check if DST is in effect for the given date
    const isDST = isEasternTimeDST(date); // [cite: 1651]
    const utcOffset = isDST ? 4 : 5; // EDT=UTC-4, EST=UTC-5 // [cite: 1651]

    // Query window: Full day in ET, represented in UTC
    const queryStart = new Date(Date.UTC(year, month, day, utcOffset, 0, 0)); // [cite: 1652]
    const queryEnd = new Date(Date.UTC(year, month, day + 1, utcOffset, 0, 0)); // [cite: 1653]

    // Business hours for creating slots (9 AM - 5 PM ET)
    const slotsStart = new Date(Date.UTC(year, month, day, 9 + utcOffset, 0, 0)); // [cite: 1654]
    const slotsEnd = new Date(Date.UTC(year, month, day, 17 + utcOffset, 0, 0)); // [cite: 1655]

    console.log(`DST in effect: ${isDST}, Using UTC offset: ${utcOffset}`); // [cite: 1656]
    console.log(`Querying events for full day: ${queryStart.toISOString()} to ${queryEnd.toISOString()}`); // [cite: 1656]
    console.log(`Will create slots within business hours: ${slotsStart.toISOString()} to ${slotsEnd.toISOString()}`); // [cite: 1657]
    const calendarId = await findWorkCalendar(); // [cite: 1657]

    // Query Google Calendar for the *entire day*
    const response = await calendar.events.list({ // [cite: 1658]
      calendarId: calendarId,
      timeMin: queryStart.toISOString(),
      timeMax: queryEnd.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100, // Limit results just in case
      timeZone: BUSINESS_TIMEZONE // Query in the business timezone
    });
    // Filter out cancelled and transparent events
    const rawEvents = response.data.items.filter(event => // [cite: 1658]
      event.status !== 'cancelled' &&
      (!event.transparency || event.transparency !== 'transparent')
    );
	
	// --->>> ADD THIS LINE EXACTLY AS SHOWN <<<---
	console.log(`Raw events fetched:`, JSON.stringify(rawEvents, null, 2));
	// --->>> END OF LINE TO ADD <<<---
	
    console.log(`Found ${rawEvents.length} raw events potentially overlapping with ${date}`); // [cite: 1659]

    // *** START: MODIFIED All-Day Event Processing Logic ***
    const processedEvents = []; // [cite: 1660]
    rawEvents.forEach(event => { // [cite: 1660]
      if (event.start.date) { // Handle All-Day Events // [cite: 1660]
         console.log(`Processing Raw Event (All-Day Check): ${event.summary}, Start: ${event.start.date}, End: ${event.end.date}`); // [cite: 1660]
         // Parse all-day event dates as UTC midnight
         const eventStartDate = new Date(event.start.date + 'T00:00:00Z'); // [cite: 1661]
         // End date is exclusive, so no need to adjust it for comparison
         const eventEndDateExclusive = new Date(event.end.date + 'T00:00:00Z'); // [cite: 1661]

         // Check if the *selected date* falls within the all-day event's range
         if (selectedDateUTC >= eventStartDate && selectedDateUTC < eventEndDateExclusive) { // [cite: 1661]
            console.log(`---> All-Day event "${event.summary}" BLOCKS the selected date ${date}. Adding full business day block.`); // [cite: 1662]
            // Add a synthetic event blocking the *entire business day* (9am-5pm ET)
            processedEvents.push({ // [cite: 1662]
                summary: `${event.summary} (All-Day Block for ${date})`,
                start: { dateTime: slotsStart.toISOString() }, // Blocks 9am ET // [cite: 1662]
                end: { dateTime: slotsEnd.toISOString() },     // Blocks until 5pm ET // [cite: 1662]
                isSyntheticAllDay: true // Flag for debugging/potential future use // [cite: 1662]
            });
         } else { // [cite: 1663]
           console.log(`---> All-Day event "${event.summary}" does NOT block the selected date ${date}.`); // [cite: 1664]
         }

      } else if (event.start.dateTime) { // Handle Timed Events // [cite: 1664]
         console.log(`Processing Raw Event (Timed): ${event.summary}, Time: ${event.start.dateTime} - ${event.end.dateTime}`); // [cite: 1665]
         // Add timed events directly if they overlap the business hours at all
         const eventStart = new Date(event.start.dateTime); // [cite: 1666]
         const eventEnd = new Date(event.end.dateTime); // [cite: 1666]
         // Check for any overlap with business hours (9am-5pm ET)
         if (eventStart < slotsEnd && eventEnd > slotsStart) { // [cite: 1667]
             processedEvents.push(event); // [cite: 1667]
         } else { // [cite: 1667]
              console.log(`---> Timed event "${event.summary}" is outside business hours ${slotsStart.toISOString()} - ${slotsEnd.toISOString()}. Skipping.`); // [cite: 1668]
         }
      } else {
        console.log(`Event (Unknown type): ${event.summary}. Skipping.`); // [cite: 1669]
      }
    });
    // *** END: MODIFIED All-Day Event Processing Logic ***

    console.log(`Total processed events (timed + synthetic all-day blocks) for calculations: ${processedEvents.length}`); // [cite: 1670]

    // Calculate adjacent slots using the PROCESSED events list
    const availableSlots = calculateAdjacentSlots(processedEvents, slotsStart, slotsEnd); // [cite: 1671]
    console.log(`Returning ${availableSlots.length} available adjacent slots for ${date}`); // [cite: 1672]
    res.json(availableSlots);
  } catch (error) {
    console.error('Error fetching available slots:', error); // [cite: 1672]
    res.status(500).send(error.message || 'Failed to fetch available slots'); // [cite: 1673]
  }
});

// Helper function to round a Date object DOWN to the nearest 30-minute mark (e.g., 10:05 -> 10:00, 10:35 -> 10:30)
function roundDown30(date) {
  const rounded = new Date(date);
  rounded.setSeconds(0, 0);
  const minutes = rounded.getMinutes();
  if (minutes >= 30) {
    rounded.setMinutes(30);
  } else {
    rounded.setMinutes(0);
  }
  return rounded;
}

// Helper function to round a Date object UP to the nearest 30-minute mark (e.g., 9:55 -> 10:00, 9:25 -> 9:30)
function roundUp30(date) {
  const rounded = new Date(date);
  rounded.setSeconds(0, 0);
  const minutes = rounded.getMinutes();
  if (minutes > 30) {
    rounded.setMinutes(0);
    rounded.setHours(rounded.getHours() + 1);
  } else if (minutes > 0 && minutes <= 30) {
    rounded.setMinutes(30);
  }
  // If minutes are already 0, do nothing
  return rounded;
}




// ----------------------------------------------
//  BOOK APPOINTMENT (Strictly enforce 9-5 Eastern)
// ----------------------------------------------
app.post('/api/book', async (req, res) => {
  const { startTime, endTime, name, email, timezone } = req.body;
  if (!startTime || !endTime || !name || !email) {
    return res.status(400).send('Missing required parameters');
  }
  const userTimezone = timezone || BUSINESS_TIMEZONE;
  const yourEmail = "Nicholas.C.Jacobson@dartmouth.edu";

  try {
    await ensureValidTokens();
    const calendar = getCalendarClient();

    console.log(`Booking request: ${name} (${email}) from ${startTime} to ${endTime}, tz: ${userTimezone}`);

    // Parse the times as UTC dates
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    
    // Check if the booking is on a weekend
    const dayOfWeek = startDate.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return res.status(400).send('Appointments cannot be booked on weekends');
    }

    // Validate 9-5 Eastern Time constraint (using proper UTC hours for Eastern Time)
    // 9 AM ET = 14:00 UTC, 5 PM ET = 22:00 UTC
    const startHourUTC = startDate.getUTCHours();
    const endHourUTC = endDate.getUTCHours();
    const startMinUTC = startDate.getUTCMinutes();
    const endMinUTC = endDate.getUTCMinutes();

    console.log(`Time in UTC: ${startHourUTC}:${startMinUTC} - ${endHourUTC}:${endMinUTC}`);
    
    if (
      startHourUTC < 14 || (startHourUTC === 22 && startMinUTC > 0) || startHourUTC > 22 ||
      endHourUTC < 14 || endHourUTC > 22
    ) {
      return res.status(400).send('Appointments must be between 9AM and 5PM Eastern Time');
    }

    const zoomLink = "dartmouth.zoom.us/my/jacobsonlab";
    
    // Format for display in the user's timezone
    const formattedDate = new Date(startTime).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: userTimezone
    });
    
    const formattedStartTime = new Date(startTime).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: userTimezone
    });
    
    const formattedEndTime = new Date(endTime).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: userTimezone
    });

    const eventDescription = `
Meeting with: ${name}
Email: ${email}
Date: ${formattedDate}
Time: ${formattedStartTime} - ${formattedEndTime} (${userTimezone})
Zoom link: https://${zoomLink}

This meeting was booked via Dr. Jacobson's Meeting Scheduler App.
`;

    const event = {
      summary: `Meeting with ${name} & Nick Jacobson`,
      description: eventDescription,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: BUSINESS_TIMEZONE
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: BUSINESS_TIMEZONE
      },
      attendees: [
        { email: email },
        { email: yourEmail }
      ],
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email", minutes: 60 },
          { method: "popup", minutes: 10 }
        ]
      },
      sendUpdates: 'all',
      guestsCanSeeOtherGuests: true
    };

    const calendarId = await findWorkCalendar();
    const response = await calendar.events.insert({
      calendarId: calendarId,
      resource: event,
      sendUpdates: 'all',
      supportsAttachments: false
    });

    console.log(`Successfully booked appointment: ${response.data.htmlLink}`);
    res.json(response.data);
  } catch (error) {
    console.error('Error booking appointment:', error);
    res.status(500).send(error.message || 'Failed to book appointment');
  }
});

// ----------------------------------------------
// CALCULATE ADJACENT 30-MINUTE SLOTS (Uses Processed Events)
// Only creates slots from 9AM to 5PM Eastern
function calculateAdjacentSlots(processedEvents, startOfBusinessDay, endOfBusinessDay) {
  console.log("Calculating adjacent slots within business hours:", startOfBusinessDay.toISOString(), "-", endOfBusinessDay.toISOString());
  console.log("Processed events for calculation:", processedEvents.map(e => ({ // Log the events it ACTUALLY uses
    summary: e.summary,
    start: e.start.dateTime, // Should always have dateTime now
    end: e.end.dateTime,
    isSyntheticAllDay: e.isSyntheticAllDay || false
  })));

  // Build all potential 30-min slots within business hours (Unchanged)
  const slots = [];
  let current = new Date(startOfBusinessDay);
  while (current < endOfBusinessDay) {
    const slotStart = new Date(current);
    const slotEnd = new Date(current);
    slotEnd.setMinutes(slotEnd.getMinutes() + 30);
    if (slotEnd <= endOfBusinessDay) {
      slots.push({
        start: slotStart,
        end: slotEnd,
        isOverlapping: false,
        isAdjacent: false
      });
    }
    current.setMinutes(current.getMinutes() + 30);
  }
  console.log(`Created ${slots.length} potential 30-minute slots within business hours.`);

  // If no processed events exist, no slots can be adjacent.
  if (processedEvents.length === 0) {
    console.log("No processed events found overlapping business hours, returning 0 adjacent slots.");
    return [];
  }

  // Mark slots as overlapping or adjacent based on PROCESSED events
  for (const event of processedEvents) {
    // Events should now always have dateTime (original or synthetic)
    if (!event.start.dateTime || !event.end.dateTime) {
        console.log(`Skipping processed event with missing time info: ${event.summary}`);
        continue;
    }

    const eventStart = new Date(event.start.dateTime);
    const eventEnd = new Date(event.end.dateTime);
    // Check if it was marked as a synthetic all-day block
    const isAllDayBlock = event.isSyntheticAllDay || false;

    console.log(`Processing ${isAllDayBlock ? 'All-Day Block' : 'Timed Event'}: ${event.summary}, ${eventStart.toISOString()} - ${eventEnd.toISOString()}`);

    // --- Rounding for Adjacency (Unchanged) ---
    const effectiveStartRoundedDown = roundDown30(eventStart);
    const effectiveEndRoundedUp = roundUp30(eventEnd);

    for (const slot of slots) {
      if (slot.isOverlapping) continue;

      // --- Overlap Check (Simpler now) ---
      if (slot.start < eventEnd && slot.end > eventStart) {
        slot.isOverlapping = true;
        console.log(`Slot ${slot.start.toISOString()} marked as overlapping by ${event.summary}`);
        continue; // If it overlaps, it cannot be adjacent
      }

      // --- Adjacent Check (Using Rounded Times) ---
      // Only check adjacency for NON-all-day blocks
      if (!isAllDayBlock) {
        const endsBeforeEventStarts = slot.end.getTime() === effectiveStartRoundedDown.getTime();
        const startsAfterEventEnds = slot.start.getTime() === effectiveEndRoundedUp.getTime();

        if (endsBeforeEventStarts || startsAfterEventEnds) {
           // Double-check non-overlap
           if (!(slot.start < eventEnd && slot.end > eventStart)) {
             slot.isAdjacent = true;
             console.log(`Slot ${slot.start.toISOString()} marked as ADJACENT to ${event.summary} (Effective boundaries: ${effectiveStartRoundedDown.toISOString()} / ${effectiveEndRoundedUp.toISOString()})`);
           }
        }
      }
    }
  }

  // Filter for slots that are NOT overlapping AND ARE adjacent (Unchanged)
  const availableAdjacentSlots = slots
    .filter(slot => !slot.isOverlapping && slot.isAdjacent)
    .map(slot => ({
      start: slot.start.toISOString(),
      end: slot.end.toISOString()
    }));

  console.log(`Found ${availableAdjacentSlots.length} available adjacent slots after filtering.`);
  return availableAdjacentSlots;
}





// ----------------------------------------------
//  DATE RANGE AVAILABILITY
// ----------------------------------------------
app.get('/api/date-range-availability', async (req, res) => {
  const { startDate, endDate, timezone } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).send('Start and end date parameters are required');
  }
  
  const userTimezone = timezone || BUSINESS_TIMEZONE;
  
  try {
    await ensureValidTokens();
    const calendar = getCalendarClient();
    
    // Parse dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    // Check if date range is valid
    if (start > end) {
      return res.status(400).send('Start date must be before end date');
    }
    
    // Calculate days in range
    const days = [];
    let currentDate = new Date(start);
    
    while (currentDate <= end) {
      days.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    // Get availability for each day
    const availability = {};
    
    for (const day of days) {
      const dateStr = day.toISOString().split('T')[0];
      const dayOfWeek = day.getDay();
      
      // Skip weekends
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        availability[dateStr] = {
          adjacent: [],
          all: [],
          isWeekend: true
        };
        continue;
      }
      
      // Check if DST is in effect
      const isDST = isEasternTimeDST(dateStr);
      const utcOffset = isDST ? 4 : 5;
      
      // Create query times (8AM-5PM Eastern)
      const queryStart = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 8 + utcOffset, 0, 0));
      const queryEnd = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 17 + utcOffset, 0, 0));
      
      // Create slot times (9AM-5PM Eastern)
      const slotsStart = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 9 + utcOffset, 0, 0));
      const slotsEnd = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 17 + utcOffset, 0, 0));
      
      // Get calendar ID
      const calendarId = await findWorkCalendar();
      
      // Query events
      const response = await calendar.events.list({
        calendarId: calendarId,
        timeMin: queryStart.toISOString(),
        timeMax: queryEnd.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 100,
        timeZone: BUSINESS_TIMEZONE
      });
      
	//------------------------------------------------------------
	// 1) Filter raw events (remove cancelled / transparent)
	//------------------------------------------------------------
	const rawEvents = response.data.items.filter(ev =>
	  ev.status !== 'cancelled' &&
	  (!ev.transparency || ev.transparency !== 'transparent')
	);

	//------------------------------------------------------------
	// 2) Convert them into “processedEvents” so     
	//    every entry ALWAYS has start.dateTime/end.dateTime. 
	//    – timed events pass straight through               
	//    – all‑day events that cover this calendar day get  
	//      a synthetic 9‑to‑5 ET block                      
	//------------------------------------------------------------
	const processedEvents = [];

	rawEvents.forEach(ev => {
	  /* -------- All‑day -------- */
	  if (ev.start?.date) {
		// All‑day events come with inclusive start date and
		//   exclusive end date (per Google Calendar spec).
		const eventStartUTC = new Date(ev.start.date + 'T00:00:00Z');
		const eventEndExclusiveUTC = new Date(ev.end.date + 'T00:00:00Z');

		// “day” is the Date object we’re iterating over in this loop
		if (day >= eventStartUTC && day < eventEndExclusiveUTC) {
		  processedEvents.push({
			summary: `${ev.summary} (All‑Day Block)`,
			start: { dateTime: slotsStart.toISOString() }, // 9 AM ET
			end:   { dateTime: slotsEnd.toISOString() },   // 5 PM ET
			isSyntheticAllDay: true
		  });
		}

	  /* -------- Timed -------- */
	  } else if (ev.start?.dateTime) {
		const evStart = new Date(ev.start.dateTime);
		const evEnd   = new Date(ev.end.dateTime);
		// Keep only those that touch the 9‑5 window
		if (evStart < slotsEnd && evEnd > slotsStart) {
		  processedEvents.push(ev);
		}
	  }
	});

	//------------------------------------------------------------
	// 3) Let the slot calculators work off the *processed* list
	//------------------------------------------------------------
	const adjacentSlots = calculateAdjacentSlots(
	  processedEvents,
	  slotsStart,
	  slotsEnd
	);
	const allSlots = calculateAllSlots(
	  processedEvents,
	  slotsStart,
	  slotsEnd
	);

      
      availability[dateStr] = {
        adjacent: adjacentSlots,
        all: allSlots,
        isWeekend: false
      };
    }
    
    res.json(availability);
  } catch (error) {
    console.error('Error fetching date range availability:', error);
    res.status(500).send(error.message || 'Failed to fetch date range availability');
  }
});

// ----------------------------------------------
// CALCULATE ALL 30-MINUTE SLOTS (Uses Processed Events)
// Only from 9AM to 5PM Eastern
function calculateAllSlots(processedEvents, startOfBusinessDay, endOfBusinessDay) {
    console.log("Calculating ALL available slots within business hours:", startOfBusinessDay.toISOString(), "-", endOfBusinessDay.toISOString());
     console.log("Processed events for calculation:", processedEvents.map(e => ({ // Log the events it ACTUALLY uses
        summary: e.summary,
        start: e.start.dateTime, // Should always have dateTime now
        end: e.end.dateTime
      })));


    // Build all potential 30-min slots within business hours (Unchanged)
    const slots = [];
    let current = new Date(startOfBusinessDay);
    while (current < endOfBusinessDay) {
        const slotStart = new Date(current);
        const slotEnd = new Date(current);
        slotEnd.setMinutes(slotEnd.getMinutes() + 30);
        if (slotEnd <= endOfBusinessDay) {
            slots.push({
                start: slotStart,
                end: slotEnd,
                isOverlapping: false
            });
        }
        current.setMinutes(current.getMinutes() + 30);
    }
    console.log(`Created ${slots.length} potential 30-minute slots.`);

    // Mark slots as overlapping based on PROCESSED events
    for (const event of processedEvents) {
       // Events should now always have dateTime (original or synthetic)
        if (!event.start.dateTime || !event.end.dateTime) {
            console.log(`Skipping processed event with missing time info: ${event.summary}`);
            continue;
        }
        const eventStart = new Date(event.start.dateTime);
        const eventEnd = new Date(event.end.dateTime);

         console.log(`Processing event for overlap: ${event.summary}, ${eventStart.toISOString()} - ${eventEnd.toISOString()}`);


        for (const slot of slots) {
           if (slot.isOverlapping) continue;
            // Overlap check (Simpler now)
            if (slot.start < eventEnd && slot.end > eventStart) {
                slot.isOverlapping = true;
                 console.log(`Slot ${slot.start.toISOString()} marked as overlapping by ${event.summary}`);
            }
        }
    }

    // Return only non-overlapping slots (Unchanged)
    const availableSlots = slots
        .filter(slot => !slot.isOverlapping)
        .map(slot => ({
            start: slot.start.toISOString(),
            end: slot.end.toISOString()
        }));

    console.log(`Found ${availableSlots.length} non-overlapping slots.`);
    return availableSlots;
}


// ----------------------------------------------
//  ADMIN AVAILABILITY PAGE (NO LOGIN REQUIRED)
// ----------------------------------------------
app.get('/admin-availability', (req, res) => {
  const adminHTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Date Range Availability</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      margin: 0;
      padding: 20px;
      color: #333;
    }
    .container {
      max-width: 1000px;
      margin: 0 auto;
    }
    h1, h2 {
      color: #2c3e50;
      margin-bottom: 20px;
    }
    .form-group {
      margin-bottom: 15px;
    }
    label {
      display: block;
      margin-bottom: 5px;
      font-weight: bold;
    }
    input[type="date"] {
      padding: 8px;
      border: 1px solid #ddd;
      border-radius: 4px;
      width: 200px;
    }
    button {
      padding: 10px 15px;
      background-color: #3498db;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-weight: bold;
      transition: background-color 0.3s;
    }
    button:hover {
      background-color: #2980b9;
    }
    .results-container {
      display: flex;
      flex-wrap: wrap;
      gap: 20px;
      margin-top: 20px;
    }
    .results-section {
      flex: 1;
      min-width: 300px;
    }
    .results {
      white-space: pre-wrap;
      font-family: monospace;
      background-color: #f5f5f5;
      padding: 15px;
      border: 1px solid #ddd;
      border-radius: 4px;
      min-height: 200px;
      margin-bottom: 10px;
    }
    .copy-btn {
      background-color: #2ecc71;
      display: block;
      width: 100%;
    }
    .copy-btn:hover {
      background-color: #27ae60;
    }
    .loading {
      display: none;
      text-align: center;
      margin: 20px 0;
    }
    .spinner {
      border: 4px solid #f3f3f3;
      border-top: 4px solid #3498db;
      border-radius: 50%;
      width: 30px;
      height: 30px;
      animation: spin 2s linear infinite;
      margin: 0 auto;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Date Range Availability</h1>
    <div class="form-group">
      <label for="startDate">Start Date:</label>
      <input type="date" id="startDate" required>
    </div>
    <div class="form-group">
      <label for="endDate">End Date:</label>
      <input type="date" id="endDate" required>
    </div>
    <button id="fetchBtn">Fetch Availability</button>
    
    <div id="loading" class="loading">
      <div class="spinner"></div>
      <p>Loading availability data...</p>
    </div>
    
    <div class="results-container">
      <div class="results-section">
        <h2>Adjacent Slots</h2>
        <div id="adjacentResults" class="results"></div>
        <button id="copyAdjacentBtn" class="copy-btn">Copy Adjacent Slots</button>
      </div>
      
      <div class="results-section">
        <h2>All Available Slots</h2>
        <div id="allResults" class="results"></div>
        <button id="copyAllBtn" class="copy-btn">Copy All Available Slots</button>
      </div>
    </div>
  </div>

  <script>
    document.addEventListener('DOMContentLoaded', function() {
      const fetchBtn = document.getElementById('fetchBtn');
      const copyAdjacentBtn = document.getElementById('copyAdjacentBtn');
      const copyAllBtn = document.getElementById('copyAllBtn');
      const adjacentResultsDiv = document.getElementById('adjacentResults');
      const allResultsDiv = document.getElementById('allResults');
      const loadingDiv = document.getElementById('loading');
      
      // Set default dates (today and 7 days from now)
      const today = new Date();
      const nextWeek = new Date();
      nextWeek.setDate(today.getDate() + 7);
      
      document.getElementById('startDate').valueAsDate = today;
      document.getElementById('endDate').valueAsDate = nextWeek;
      
      fetchBtn.addEventListener('click', fetchAvailability);
      copyAdjacentBtn.addEventListener('click', () => copyToClipboard('adjacent'));
      copyAllBtn.addEventListener('click', () => copyToClipboard('all'));
      
      function fetchAvailability() {
        const startDate = document.getElementById('startDate').value;
        const endDate = document.getElementById('endDate').value;
        
        if (!startDate || !endDate) {
          alert('Please select both start and end dates');
          return;
        }
        
        adjacentResultsDiv.textContent = '';
        allResultsDiv.textContent = '';
        loadingDiv.style.display = 'block';
        
        fetch('/api/date-range-availability?startDate=' + startDate + '&endDate=' + endDate)
          .then(response => {
            if (!response.ok) {
              throw new Error('Network response was not ok');
            }
            return response.json();
          })
          .then(data => {
            loadingDiv.style.display = 'none';
            formatResults(data);
          })
          .catch(error => {
            console.error('Error fetching availability:', error);
            loadingDiv.style.display = 'none';
            adjacentResultsDiv.textContent = 'Error fetching availability. Please try again.';
            allResultsDiv.textContent = 'Error fetching availability. Please try again.';
          });
      }
      
      function formatResults(data) {
        // Format adjacent slots
        let adjacentText = 'AVAILABILITY\\n';
        adjacentText += '============\\n';
        adjacentText += 'All times are shown in Eastern Time (ET)\\n\\n';
        
        // Format all available slots
        let allText = 'AVAILABILITY\\n';
        allText += '============\\n';
        allText += 'All times are shown in Eastern Time (ET)\\n\\n';
        
        // Check if any data exists
        const dates = Object.keys(data).sort();
        if (dates.length === 0) {
          const noDataMsg = 'No dates found in the selected range.';
          adjacentResultsDiv.textContent = noDataMsg;
          allResultsDiv.textContent = noDataMsg;
          return;
        }
        
        dates.forEach(date => {
          const dayData = data[date];
          const dateObj = new Date(date + 'T00:00:00');
          const formattedDate = dateObj.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });
          
          // Create underline that matches the date length
          const underline = '='.repeat(formattedDate.length);
          
          // Add date heading to both sections
          adjacentText += formattedDate + '\\n';
          adjacentText += underline + '\\n';
          
          allText += formattedDate + '\\n';
          allText += underline + '\\n';
          
          if (dayData.isWeekend) {
            adjacentText += 'Weekend - No availability\\n\\n';
            allText += 'Weekend - No availability\\n\\n';
          } else {
            // Adjacent slots - no label mentioning "adjacent"
            if (dayData.adjacent.length === 0) {
              adjacentText += '- None available\\n';
            } else {
              dayData.adjacent.forEach(slot => {
                const start = new Date(slot.start);
                const end = new Date(slot.end);
                
                // Format times in Eastern Time
                const startTime = formatTimeInET(start);
                const endTime = formatTimeInET(end);
                
                adjacentText += '- ' + startTime + ' - ' + endTime + '\\n';
              });
            }
            
            // All available slots - no label mentioning "all available"
            if (dayData.all.length === 0) {
              allText += '- None available\\n';
            } else {
              dayData.all.forEach(slot => {
                const start = new Date(slot.start);
                const end = new Date(slot.end);
                
                // Format times in Eastern Time
                const startTime = formatTimeInET(start);
                const endTime = formatTimeInET(end);
                
                allText += '- ' + startTime + ' - ' + endTime + '\\n';
              });
            }
          }
          
          adjacentText += '\\n';
          allText += '\\n';
        });
        
        adjacentResultsDiv.textContent = adjacentText;
        allResultsDiv.textContent = allText;
      }
      
      // Helper function to format time in Eastern Time
      function formatTimeInET(date) {
        // New York time zone for Eastern Time
        return date.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
          timeZone: 'America/New_York'
        });
      }
      
      function copyToClipboard(type) {
        const text = type === 'adjacent' ? adjacentResultsDiv.textContent : allResultsDiv.textContent;
        
        if (!text || text === '') {
          alert('No data to copy');
          return;
        }
        
        navigator.clipboard.writeText(text)
          .then(() => {
            alert('Copied to clipboard!');
          })
          .catch(err => {
            console.error('Failed to copy: ', err);
            alert('Failed to copy to clipboard');
          });
      }
    });
  </script>
</body>
</html>
  `;
  res.send(adminHTML);
});



// ----------------------------------------------
//  FALLBACK HTML if client build is missing
// ----------------------------------------------
app.use((req, res, next) => {
  if (
    process.env.NODE_ENV === 'production' &&
    req.method === 'GET' &&
    !req.path.startsWith('/api/') &&
    !req.path.startsWith('/auth/')
  ) {
    const indexPath = path.join(__dirname, 'client/build', 'index.html');
    if (fs.existsSync(indexPath)) {
      return next();
    }
    console.log("Index file not found, serving fallback HTML for path:", req.path);
    const fallbackHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Meeting Scheduler</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 20px; text-align: center; }
          h1 { color: #333; }
          .container { max-width: 800px; margin: 0 auto; }
          .btn { display: inline-block; padding: 10px 20px; background-color: #4CAF50; color: white; 
                 text-decoration: none; border-radius: 4px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Meeting Scheduler</h1>
          <p>The application is running, but the client build files were not found.</p>
          <p>Please complete the admin setup to use the scheduler:</p>
          <a href="/auth/admin" class="btn">Admin Setup</a>
        </div>
      </body>
      </html>
    `;
    return res.send(fallbackHTML);
  }
  next();
});

// ----------------------------------------------
//  SERVE STATIC FILES IN PRODUCTION
// ----------------------------------------------
if (process.env.NODE_ENV === 'production') {
  console.log("Setting up static file serving for production");
  const possibleBuildPaths = [
    path.join(__dirname, 'client/build'),
    path.join(__dirname, '../client/build'),
    path.join(__dirname, 'build'),
    path.join(process.cwd(), 'client/build')
  ];
  let staticPath = null;
  for (const buildPath of possibleBuildPaths) {
    if (fs.existsSync(buildPath)) {
      console.log(`Found static files at: ${buildPath}`);
      staticPath = buildPath;
      break;
    } else {
      console.log(`Static path not found: ${buildPath}`);
    }
  }
  if (staticPath) {
    app.use(express.static(staticPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
        return next();
      }
      const indexPath = path.join(staticPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('Static files were found but index.html is missing');
      }
    });
  } else {
    console.log("No static file path found!");
  }
}

// ----------------------------------------------
//  SERVER PING (PREVENT SLEEP)
// ----------------------------------------------
const https = require('https');

// Self-ping function to keep the server awake
function pingServer() {
  const serverUrl = process.env.SERVER_URL || `http://localhost:${PORT}`;
  console.log(`Pinging server at: ${serverUrl}`);
  
  // Use built-in http/https modules to make the request
  try {
    const request = serverUrl.startsWith('https') ? https.get(serverUrl) : require('http').get(serverUrl);
    
    request.on('response', (response) => {
      console.log(`Self-ping successful with status: ${response.statusCode}`);
    });
    
    request.on('error', (error) => {
      console.error('Self-ping failed:', error.message);
    });
  } catch (error) {
    console.error('Error during self-ping:', error.message);
  }
}

// Schedule the ping to run every 14 minutes (Render sleeps after 15 minutes of inactivity)
if (process.env.NODE_ENV === 'production') {
  // 14 minutes in milliseconds = 14 * 60 * 1000 = 840000
  setInterval(pingServer, 840000);
  console.log('Scheduled self-ping every 14 minutes to prevent server sleep');
}


// ----------------------------------------------
//  START SERVER
// ----------------------------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Admin authentication status: ${adminTokens ? 'Authenticated' : 'Not authenticated'}`);
  console.log(`To authenticate as admin, visit: /auth/admin`);
  console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(`Business hours: 9AM-5PM in ${BUSINESS_TIMEZONE}`);
  console.log(`Checking for meetings from 8AM to 5PM for adjacency`);
});