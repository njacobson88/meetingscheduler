/***************************************************
 * server.js
 ***************************************************/
const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const moment = require('moment-timezone');  // Added moment-timezone

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3001;

// For your default, use 'America/New_York'
const TIMEZONE = 'America/New_York';

// Debug logs for the file system (optional)
console.log("=== DEBUGGING FILE SYSTEM ===");
console.log("Current working directory:", process.cwd());
console.log("__dirname:", __dirname);
console.log("=== END DEBUGGING ===");

app.use(cors());
app.use(express.json());

// ----------------------------------------------
//  OAUTH & TOKEN LOGIC
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
//  MONTH AVAILABILITY (9-5 EST only, adjacent logic)
// ----------------------------------------------
app.get('/api/month-availability', async (req, res) => {
  const { year, month, timezone } = req.query;
  if (!year || !month) {
    return res.status(400).send('Year and month parameters are required');
  }

  const userTimezone = timezone || TIMEZONE;

  try {
    await ensureValidTokens();
    const calendar = getCalendarClient();

    const yearNum = parseInt(year, 10);
    const monthNum = parseInt(month, 10); // 1-based from client?

    // Build start/end of the month in the user’s timezone, 9–5 checks come later.
    // We'll fetch all events for the entire month in that TZ, then filter.
    const startOfMonth = moment.tz([yearNum, monthNum - 1, 1], userTimezone).startOf('day');
    const endOfMonth = moment.tz([yearNum, monthNum - 1, 1], userTimezone)
                          .endOf('month').hour(23).minute(59).second(59).millisecond(999);

    console.log(`Finding availability for ${year}-${month} in TZ ${userTimezone}`);

    const calendarId = await findWorkCalendar();

    const response = await calendar.events.list({
      calendarId,
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

    const daysInMonth = endOfMonth.date(); // number of days in the chosen month
    const availability = {};

    // Check each day for adjacent slots
    for (let day = 1; day <= daysInMonth; day++) {
      // Local day range from 9:00 -> 17:00
      const dayStart = moment.tz([yearNum, monthNum - 1, day], userTimezone)
                            .hour(9).minute(0).second(0).millisecond(0);
      const dayEnd = moment.tz([yearNum, monthNum - 1, day], userTimezone)
                          .hour(17).minute(0).second(0).millisecond(0);

      // Filter events for this calendar day (that overlap 9–5 in some way)
      const dayEvents = events.filter(ev => {
        if (!ev.start.dateTime || !ev.end.dateTime) return false;

        const evStart = moment.tz(ev.start.dateTime, userTimezone);
        // Compare if they're on the same date (in this TZ)
        return evStart.year() === dayStart.year() &&
               evStart.month() === dayStart.month() &&
               evStart.date() === dayStart.date();
      });

      // Calculate 30-min adjacent slots for that day
      const freeSlots = calculateAdjacentSlots(dayEvents, dayStart, dayEnd, userTimezone);
      availability[dayStart.format('YYYY-MM-DD')] = (freeSlots.length > 0);
    }

    res.json(availability);
  } catch (error) {
    console.error('Error fetching month availability:', error);
    res.status(500).send(error.message || 'Failed to fetch month availability');
  }
});

// ----------------------------------------------
//  DAY AVAILABILITY (9-5 local time only)
// ----------------------------------------------
app.get('/api/available-slots', async (req, res) => {
  const { date, timezone } = req.query;
  if (!date) {
    return res.status(400).send('Date parameter is required (YYYY-MM-DD)');
  }
  const userTimezone = timezone || TIMEZONE;

  try {
    await ensureValidTokens();
    const calendar = getCalendarClient();

    // Parse the date in the user’s TZ. Then set 9am–5pm.
    const [yearStr, monthStr, dayStr] = date.split('-');
    const yearNum = parseInt(yearStr, 10);
    const monthNum = parseInt(monthStr, 10);
    const dayNum = parseInt(dayStr, 10);

    const startOfDay = moment.tz([yearNum, monthNum - 1, dayNum], userTimezone)
                            .hour(9).minute(0).second(0).millisecond(0);
    const endOfDay = moment.tz([yearNum, monthNum - 1, dayNum], userTimezone)
                          .hour(17).minute(0).second(0).millisecond(0);

    console.log(`Finding available slots for ${date} in TZ ${userTimezone}:`);
    console.log(`Local day range: ${startOfDay.format()} - ${endOfDay.format()}`);

    const calendarId = await findWorkCalendar();

    // Retrieve events that fall (even partially) between 9am–5pm in that TZ
    const response = await calendar.events.list({
      calendarId,
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

    console.log(`Found ${events.length} events in the 9–5 range for that day.`);
    const availableSlots = calculateAdjacentSlots(events, startOfDay, endOfDay, userTimezone);

    res.json(availableSlots);
  } catch (error) {
    console.error('Error fetching available slots:', error);
    res.status(500).send(error.message || 'Failed to fetch available slots');
  }
});

// ----------------------------------------------
//  BOOK APPOINTMENT
// ----------------------------------------------
app.post('/api/book', async (req, res) => {
  const { startTime, endTime, name, email, timezone } = req.body;
  if (!startTime || !endTime || !name || !email) {
    return res.status(400).send('Missing required parameters');
  }
  const userTimezone = timezone || TIMEZONE;
  const yourEmail = "njacobson88@gmail.com";

  try {
    await ensureValidTokens();
    const calendar = getCalendarClient();

    console.log(`Booking appointment for ${name} (${email}) from ${startTime} to ${endTime}, tz: ${userTimezone}`);

    // Parse them as moments in the user’s TZ to ensure correctness.
    const startDate = moment.tz(startTime, userTimezone);
    const endDate = moment.tz(endTime, userTimezone);

    console.log(`Parsed appointment times (local TZ): ${startDate.format()} -> ${endDate.format()}`);

    const zoomLink = "dartmouth.zoom.us/my/jacobsonlab";
    const formattedDate = startDate.format('dddd, MMMM Do YYYY');
    const formattedStartTime = startDate.format('h:mm A');
    const formattedEndTime = endDate.format('h:mm A');

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
        timeZone: userTimezone
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: userTimezone
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
      calendarId,
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
//  Only from startOfDay to endOfDay, must be next
//  to an event within 1 minute. Overlapping is excluded.
// ----------------------------------------------
function calculateAdjacentSlots(events, startMoment, endMoment, userTimezone) {
  console.log("Events found:", events.map(e => ({
    summary: e.summary,
    start: e.start.dateTime || e.start.date,
    end: e.end.dateTime || e.end.date
  })));

  // Convert moment boundaries to plain Date for iteration
  const startOfDay = startMoment.toDate();
  const endOfDay = endMoment.toDate();

  // Build all 30-min slots [startOfDay, endOfDay]
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

  // If no events, strictly no adjacency => return empty
  if (events.length === 0) {
    console.log("No events found for this day — returning [] because we only show adjacent times.");
    return [];
  }

  // Mark overlapping or adjacent
  for (const event of events) {
    if (!event.start.dateTime || !event.end.dateTime) continue;

    const eventStart = new Date(event.start.dateTime);
    const eventEnd = new Date(event.end.dateTime);

    console.log(`Processing event: "${event.summary}" from ${eventStart.toLocaleTimeString()} to ${eventEnd.toLocaleTimeString()}`);

    for (const slot of slots) {
      // Overlap check: any intersection means the slot is unavailable
      if (
        (slot.start >= eventStart && slot.start < eventEnd) ||
        (slot.end > eventStart && slot.end <= eventEnd) ||
        (slot.start <= eventStart && slot.end >= eventEnd)
      ) {
        slot.isOverlapping = true;
      }

      // Adjacent check (within 1 minute)
      const slotStartsRightAfterEventEnds = Math.abs(slot.start.getTime() - eventEnd.getTime()) < 60_000;
      const slotEndsRightBeforeEventStarts = Math.abs(slot.end.getTime() - eventStart.getTime()) < 60_000;

      if (slotStartsRightAfterEventEnds || slotEndsRightBeforeEventStarts) {
        slot.isAdjacent = true;
      }
    }
  }

  // Return only those that are NOT overlapping but ARE adjacent
  const availableSlots = slots
    .filter(slot => !slot.isOverlapping && slot.isAdjacent)
    .map(slot => ({
      start: slot.start.toISOString(),
      end: slot.end.toISOString()
    }));

  console.log(`Found ${availableSlots.length} adjacent 30-min slots free.`);
  return availableSlots;
}

// ----------------------------------------------
//  SERVE FALLBACK HTML if client build missing
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
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
        return;
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
  console.log(`To authenticate as admin, visit: http://localhost:${PORT}/auth/admin`);
  console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
});
