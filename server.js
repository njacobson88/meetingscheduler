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
const TIMEZONE = 'America/New_York'; // Default timezone

app.use(cors());
app.use(express.json());

// OAuth2 setup for admin (calendar owner)
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URL
);

// Store tokens (in production, use a secure database)
let adminTokens = null;

// Try to load tokens from a file if they exist (for development only)
// In production, use a secure database instead
try {
  if (fs.existsSync('./tokens.json')) {
    const tokensData = fs.readFileSync('./tokens.json', 'utf8');
    adminTokens = JSON.parse(tokensData);
    console.log('Loaded tokens from file');
  }
} catch (error) {
  console.error('Error loading tokens from file:', error);
}



// Admin-only auth route - keep this endpoint secured in production!
app.get('/auth/admin', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent' // Force to get refresh token
  });
  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    adminTokens = tokens;
    
    // Save tokens to file (for development only)
    saveTokensToFile(tokens);
    
    res.send('Authentication successful! The application can now access your calendar. You can close this window.');
  } catch (error) {
    console.error('Error authenticating:', error);
    res.status(500).send('Authentication failed');
  }
});

// Function to ensure we have valid tokens before making API calls
async function ensureValidTokens() {
  if (!adminTokens) {
    throw new Error('Admin not authenticated. An administrator must visit /auth/admin first.');
  }
  
  // Check if token is expired and refresh if needed
  if (adminTokens.expiry_date && adminTokens.expiry_date < Date.now()) {
    console.log('Token expired, refreshing...');
    oauth2Client.setCredentials(adminTokens);
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      adminTokens = credentials;
      // Save refreshed tokens
      saveTokensToFile(adminTokens);
    } catch (error) {
      console.error('Error refreshing token:', error);
      throw new Error('Failed to refresh authentication token. Admin must re-authenticate.');
    }
  }
  
  oauth2Client.setCredentials(adminTokens);
}

// Google Calendar API client
function getCalendarClient() {
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// Helper function to find the work calendar
async function findWorkCalendar() {
  try {
    await ensureValidTokens();
    const calendar = getCalendarClient();
    
    const calListResponse = await calendar.calendarList.list();
    const calendars = calListResponse.data.items;
    console.log("Available calendars:", calendars.map(c => c.summary));
    
    // Try to find the calendar by name
    let calendarId = 'primary'; // Default
    
    // Look for calendars with certain names
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
    return 'primary'; // Default to primary if error
  }
}

// Get availability for an entire month
app.get('/api/month-availability', async (req, res) => {
  const { year, month, timezone } = req.query;
  
  if (!year || !month) {
    return res.status(400).send('Year and month parameters are required');
  }

  const userTimezone = timezone || TIMEZONE;
  
  try {
    await ensureValidTokens();
    const calendar = getCalendarClient();
    
    // Set up the date range for the entire month
    const startOfMonth = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, 1));
    const endOfMonth = new Date(Date.UTC(parseInt(year), parseInt(month), 0, 23, 59, 59));
    
    console.log(`Finding availability for month: ${year}-${month}, timezone: ${userTimezone}`);
    
    // Find the work calendar
    let calendarId = await findWorkCalendar();
    
    // Fetch all events for the month
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: startOfMonth.toISOString(),
      timeMax: endOfMonth.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500,
      timeZone: userTimezone
    });

    const events = response.data.items.filter(event => 
      event.status !== 'cancelled' && 
      (!event.transparency || event.transparency !== 'transparent')
    );
    
    // Calculate availability for each day of the month
    const availability = {};
    
    // For each day in the month
    const daysInMonth = new Date(year, month, 0).getDate();
    
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, day));
      const dateStr = date.toISOString().split('T')[0];
      
      // Filter events for this day
      const dayEvents = events.filter(event => {
        if (!event.start.dateTime || !event.end.dateTime) return false;
        
        const eventStart = new Date(event.start.dateTime);
        const eventDate = new Date(eventStart.getFullYear(), eventStart.getMonth(), eventStart.getDate());
        const targetDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        
        return eventDate.getTime() === targetDate.getTime();
      });
      
      // Calculate available slots for this day
      const dayStartTime = new Date(date);
      dayStartTime.setHours(8, 0, 0, 0); // 8 AM
      
      const dayEndTime = new Date(date);
      dayEndTime.setHours(17, 0, 0, 0); // 5 PM
      
      const availableSlots = calculateAdjacentSlots(dayEvents, dayStartTime, dayEndTime);
      
      // Store availability for this day
      availability[dateStr] = availableSlots.length > 0;
    }
    
    res.json(availability);
  } catch (error) {
    console.error('Error fetching month availability:', error);
    res.status(500).send(error.message || 'Failed to fetch month availability');
  }
});

// Get available slots for a specific date
app.get('/api/available-slots', async (req, res) => {
  const { date, timezone } = req.query;
  if (!date) {
    return res.status(400).send('Date parameter is required');
  }

  const userTimezone = timezone || TIMEZONE;

  try {
    await ensureValidTokens();
    const calendar = getCalendarClient();
    
    console.log(`Finding available slots for date: ${date}, timezone: ${userTimezone}`);
    
    // Create date object correctly
    const dateObj = new Date(`${date}T12:00:00Z`);
    console.log(`Date interpreted as: ${dateObj.toISOString()}`);
    
    // Convert date to start and end of day
    const startOfDay = new Date(dateObj);
    startOfDay.setHours(8, 0, 0, 0); // Start at 8 AM
    
    const endOfDay = new Date(dateObj);
    endOfDay.setHours(17, 0, 0, 0); // End at 5 PM
    
    console.log(`Looking for events between ${startOfDay.toISOString()} and ${endOfDay.toISOString()}`);

    // Find the work calendar
    let calendarId = await findWorkCalendar();

    // Fetch events from Google Calendar
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
      timeZone: userTimezone
    });

    const events = response.data.items.filter(event => 
      event.status !== 'cancelled' && 
      (!event.transparency || event.transparency !== 'transparent')
    );
    
    console.log(`Found ${events.length} events for the day`);
    
    // Calculate available slots adjacent to existing meetings
    const availableSlots = calculateAdjacentSlots(events, startOfDay, endOfDay);
    
    res.json(availableSlots);
  } catch (error) {
    console.error('Error fetching available slots:', error);
    res.status(500).send(error.message || 'Failed to fetch available slots');
  }
});

// Book an appointment - with enhanced notification methods
app.post('/api/book', async (req, res) => {
  const { startTime, endTime, name, email, timezone } = req.body;
  
  if (!startTime || !endTime || !name || !email) {
    return res.status(400).send('Missing required parameters');
  }

  const userTimezone = timezone || TIMEZONE;
  const yourEmail = "njacobson88@gmail.com"; // Your email address

  try {
    await ensureValidTokens();
    const calendar = getCalendarClient();
    
    console.log(`Booking appointment for ${name} (${email}) from ${startTime} to ${endTime}, timezone: ${userTimezone}`);
    
    // Parse the dates correctly to avoid timezone issues
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    
    console.log(`Parsed appointment times: ${startDate.toISOString()} to ${endDate.toISOString()}`);
    
    // Zoom meeting information
    const zoomLink = "dartmouth.zoom.us/my/jacobsonlab";
    
    // Format the date and time for the email
    const formattedDate = startDate.toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      timeZone: userTimezone
    });
    
    const formattedStartTime = startDate.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      timeZone: userTimezone
    });
    
    const formattedEndTime = endDate.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      timeZone: userTimezone
    });

    // Enhanced description with meeting details
    const eventDescription = `
Meeting with: ${name}
Email: ${email}
Date: ${formattedDate}
Time: ${formattedStartTime} - ${formattedEndTime} (${userTimezone})
Zoom call info: https://${zoomLink}

This meeting was booked via Dr. Jacobson's Meeting Scheduler App.
`;

    const event = {
      summary: `Meeting with ${name} & Nick Jacobson`,
      description: eventDescription,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: userTimezone,
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: userTimezone,
      },
      attendees: [
        { email: email },
        { email: yourEmail } // Add your email explicitly as an attendee
      ],
      // Add reminders
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email", minutes: 60 }, // Email reminder 1 hour before
          { method: "popup", minutes: 10 }  // Popup reminder 10 minutes before
        ]
      },
      // Send email notifications to all attendees
      sendUpdates: 'all',
      // Force notifications even if Google thinks it's unnecessary
      guestsCanSeeOtherGuests: true
    };

    // Find the work calendar
    let calendarId = await findWorkCalendar();

    // Insert the event
    const response = await calendar.events.insert({
      calendarId: calendarId,
      resource: event,
      sendUpdates: 'all', // Send emails to attendees
      supportsAttachments: false
    });

    console.log(`Successfully booked appointment: ${response.data.htmlLink}`);
    
    // Removed the patch update that was causing double notifications

    res.json(response.data);
  } catch (error) {
    console.error('Error booking appointment:', error);
    res.status(500).send(error.message || 'Failed to book appointment');
  }
});

function calculateAdjacentSlots(events, startOfDay, endOfDay) {
  // Log events for debugging
  console.log("Events found:", events.map(e => ({
    summary: e.summary,
    start: e.start.dateTime || e.start.date,
    end: e.end.dateTime || e.end.date
  })));
  
  // Create all possible 30-minute slots
  const slots = [];
  let current = new Date(startOfDay);
  
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
  
  // If no events, return empty array (no adjacent slots)
  if (events.length === 0) {
    console.log("No events found for this day");
    return [];
  }
  
  // Mark slots as overlapping or adjacent
  for (const event of events) {
    // Skip events without datetime (all-day events)
    if (!event.start.dateTime || !event.end.dateTime) {
      continue;
    }
    
    const eventStart = new Date(event.start.dateTime);
    const eventEnd = new Date(event.end.dateTime);
    
    console.log(`Processing event: ${event.summary} from ${eventStart.toLocaleTimeString()} to ${eventEnd.toLocaleTimeString()}`);
    
    for (const slot of slots) {
      // Check if slot overlaps with event
      if (
        (slot.start >= eventStart && slot.start < eventEnd) ||
        (slot.end > eventStart && slot.end <= eventEnd) ||
        (slot.start <= eventStart && slot.end >= eventEnd)
      ) {
        slot.isOverlapping = true;
      }
      
      // Check if slot is EXACTLY adjacent to event (directly before or after)
      const slotStartsExactlyAfterEventEnds = 
        Math.abs(slot.start.getTime() - eventEnd.getTime()) < 60000; // Within 1 minute
      
      const slotEndsExactlyBeforeEventStarts = 
        Math.abs(slot.end.getTime() - eventStart.getTime()) < 60000; // Within 1 minute
      
      if (slotStartsExactlyAfterEventEnds || slotEndsExactlyBeforeEventStarts) {
        slot.isAdjacent = true;
        console.log(`Found adjacent slot: ${slot.start.toLocaleTimeString()} - ${slot.end.toLocaleTimeString()}`);
      }
    }
  }
  
  // Filter for available adjacent slots
  const availableSlots = slots
    .filter(slot => !slot.isOverlapping && slot.isAdjacent)
    .map(slot => ({
      start: slot.start.toISOString(),
      end: slot.end.toISOString()
    }));
  
  console.log(`Found ${availableSlots.length} available adjacent slots`);
  return availableSlots;
}

// Check authentication status
app.get('/api/check-admin-auth', (req, res) => {
  if (adminTokens) {
    res.status(200).json({ authenticated: true });
  } else {
    res.status(200).json({ authenticated: false });
  }
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'client/build')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
}

const serverPort = PORT;
app.listen(serverPort, () => {
  console.log(`Server running on port ${serverPort}`);
  console.log(`Admin authentication status: ${adminTokens ? 'Authenticated' : 'Not authenticated'}`);
  console.log(`To authenticate as admin, visit: http://localhost:${serverPort}/auth/admin`);
});



// For production, try to get tokens from environment variables
if (process.env.GOOGLE_REFRESH_TOKEN) {
  adminTokens = {
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    access_token: process.env.GOOGLE_ACCESS_TOKEN || "",
    expiry_date: parseInt(process.env.TOKEN_EXPIRY_DATE || "0")
  };
  console.log('Loaded tokens from environment variables');
} else {
  // For development, try to load tokens from a file
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

// Function to save tokens (file for development, log for production)
function saveTokensToFile(tokens) {
  try {
    // Serve static files in production
	if (process.env.NODE_ENV === 'production') {
	  app.use(express.static(path.join(__dirname, 'client/build')));
	  app.get('*', (req, res) => {
		res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
	  });
	} else {
      // In production, log the refresh token to be saved as an environment variable
      console.log('IMPORTANT - Save this as GOOGLE_REFRESH_TOKEN:', tokens.refresh_token);
      console.log('IMPORTANT - Save this as GOOGLE_ACCESS_TOKEN:', tokens.access_token);
      console.log('IMPORTANT - Save this as TOKEN_EXPIRY_DATE:', tokens.expiry_date);
    }
  } catch (error) {
    console.error('Error saving tokens:', error);
  }
}