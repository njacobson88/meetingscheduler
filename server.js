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
app.get('/api/available-slots', async (req, res) => {
  const { date, timezone } = req.query;
  if (!date) {
    return res.status(400).send('Date parameter is required');
  }
  const userTimezone = timezone || BUSINESS_TIMEZONE;

  try {
    await ensureValidTokens();
    const calendar = getCalendarClient();

    // Ensure we're using the exact date requested
    console.log(`Request for available slots on ${date} in ${userTimezone}`);
    
    // Parse date components to avoid timezone issues
    const [yearStr, monthStr, dayStr] = date.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10) - 1; // JS months are 0-indexed
    const day = parseInt(dayStr, 10);
    
    // Create dates explicitly in UTC that correspond to Eastern times
    // 8 AM ET = UTC-5 = 13:00 UTC
    const queryStart = new Date(Date.UTC(year, month, day, 13, 0, 0)); // 8AM ET 
    const queryEnd = new Date(Date.UTC(year, month, day, 22, 0, 0));   // 5PM ET

    // For creating slots (9 AM - 5 PM Eastern)
    const slotsStart = new Date(Date.UTC(year, month, day, 14, 0, 0)); // 9AM ET
    const slotsEnd = new Date(Date.UTC(year, month, day, 22, 0, 0));   // 5PM ET

    console.log(`Querying events from ${queryStart.toISOString()} to ${queryEnd.toISOString()}`);
    console.log(`Will create slots from ${slotsStart.toISOString()} to ${slotsEnd.toISOString()}`);

    const calendarId = await findWorkCalendar();

    // Query Google Calendar for events starting from 8 AM (to catch early meetings)
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: queryStart.toISOString(),
      timeMax: queryEnd.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
      timeZone: BUSINESS_TIMEZONE // Always query in Eastern Time
    });

    // Filter out cancelled and transparent events
    const events = response.data.items.filter(event =>
      event.status !== 'cancelled' &&
      (!event.transparency || event.transparency !== 'transparent')
    );

    console.log(`Found ${events.length} events for ${date} between 8AM-5PM Eastern`);
    
    // Debug: Print each event with its time
    events.forEach(event => {
      if (!event.start.dateTime || !event.end.dateTime) return;
      console.log(`Event: ${event.summary}, Time: ${event.start.dateTime} - ${event.end.dateTime}`);
    });
    
    // Calculate adjacent slots - use events from 8AM-5PM, but only create slots from 9AM-5PM
    const availableSlots = calculateAdjacentSlots(events, slotsStart, slotsEnd);
    
    console.log(`Returning ${availableSlots.length} available slots for ${date}`);
    res.json(availableSlots);
  } catch (error) {
    console.error('Error fetching available slots:', error);
    res.status(500).send(error.message || 'Failed to fetch available slots');
  }
});

// ----------------------------------------------
//  BOOK APPOINTMENT (Strictly enforce 9-5 Eastern)
// ----------------------------------------------
app.post('/api/book', async (req, res) => {
  const { startTime, endTime, name, email, timezone } = req.body;
  if (!startTime || !endTime || !name || !email) {
    return res.status(400).send('Missing required parameters');
  }
  const userTimezone = timezone || BUSINESS_TIMEZONE;
  const yourEmail = "njacobson88@gmail.com";

  try {
    await ensureValidTokens();
    const calendar = getCalendarClient();

    console.log(`Booking request: ${name} (${email}) from ${startTime} to ${endTime}, tz: ${userTimezone}`);

    // Parse the times as UTC dates
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);

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
//  CALCULATE ADJACENT 30-MINUTE SLOTS
//  Only from 9AM to 5PM Eastern
// ----------------------------------------------
function calculateAdjacentSlots(events, startOfDay, endOfDay) {
  console.log("Events found:", events.map(e => ({
    summary: e.summary,
    start: e.start.dateTime || e.start.date,
    end: e.end.dateTime || e.end.date
  })));

  // Build all 30-min slots from 9AM to 5PM Eastern Time
  const slots = [];
  let current = new Date(startOfDay);

  console.log(`Building slots from ${current.toISOString()} to ${endOfDay.toISOString()}`);

  while (current < endOfDay) {
    const slotStart = new Date(current);
    const slotEnd = new Date(current);
    slotEnd.setMinutes(slotEnd.getMinutes() + 30);

    if (slotEnd <= endOfDay) {
      slots.push({
        start: slotStart,
        end: slotEnd,
        isOverlapping: false,
        isAdjacent: false
      });
    }
    current.setMinutes(current.getMinutes() + 30);
  }

  console.log(`Created ${slots.length} 30-minute slots within business hours`);

  // If no events, return empty array (no "adjacent" slots possible)
  if (events.length === 0) {
    console.log("No events found during business hours");
    return [];
  }

  // Mark slots as overlapping or adjacent
  for (const event of events) {
    if (!event.start.dateTime || !event.end.dateTime) continue;
    
    const eventStart = new Date(event.start.dateTime);
    const eventEnd = new Date(event.end.dateTime);

    console.log(`Processing event: ${event.summary}, ${eventStart.toISOString()} - ${eventEnd.toISOString()}`);

    for (const slot of slots) {
      // Overlap check: Is this slot already occupied by an event?
      if (
        (slot.start >= eventStart && slot.start < eventEnd) ||
        (slot.end > eventStart && slot.end <= eventEnd) ||
        (slot.start <= eventStart && slot.end >= eventEnd)
      ) {
        slot.isOverlapping = true;
      }

      // Adjacent check: Is this slot immediately before or after an event?
      // Using 60 seconds (60000ms) tolerance for "adjacency"
      const slotStartsExactlyAfterEventEnds = Math.abs(slot.start.getTime() - eventEnd.getTime()) < 60000;
      const slotEndsExactlyBeforeEventStarts = Math.abs(slot.end.getTime() - eventStart.getTime()) < 60000;

      if (slotStartsExactlyAfterEventEnds || slotEndsExactlyBeforeEventStarts) {
        slot.isAdjacent = true;
        console.log(`Found adjacent slot: ${slot.start.toISOString()} - ${slot.end.toISOString()}`);
      }
    }
  }

  // Return only slots that are both non-overlapping AND adjacent to an event
  const availableSlots = slots
    .filter(slot => !slot.isOverlapping && slot.isAdjacent)
    .map(slot => ({
      start: slot.start.toISOString(),
      end: slot.end.toISOString()
    }));

  console.log(`Found ${availableSlots.length} available adjacent slots`);
  return availableSlots;
}

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