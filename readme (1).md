# Calendly-Like Meeting Scheduler

This application allows others to book 30-minute meetings with you, but with an important twist: available slots are only those directly adjacent to existing meetings. This helps you block your meetings together and preserve uninterrupted free time for focused work.

## Features

- Google Calendar integration
- Authentication with Google OAuth
- Only shows 30-minute slots that are adjacent to existing meetings
- Limits booking times to 9 AM - 5 PM
- Simple booking interface for visitors

## Setup Instructions

### Prerequisites

- Node.js (v14 or later)
- npm (v6 or later)
- Google Cloud Platform account

### Google API Setup

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable the Google Calendar API
4. Create OAuth 2.0 credentials
   - Set the authorized redirect URI to `http://localhost:3001/auth/google/callback`
5. Note your Client ID and Client Secret

### Installation

1. Clone this repository
2. Update the `.env` file with your Google credentials:
   ```
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
   GOOGLE_REDIRECT_URL=http://localhost:3001/auth/google/callback
   SESSION_SECRET=your_random_secret_string
   PORT=3001
   ```
3. Install server dependencies:
   ```
   npm install
   ```
4. Install client dependencies:
   ```
   cd client
   npm install
   cd ..
   ```

### Running the Application

To run both the server and client concurrently in development mode:

```
npm run dev
```

This will start:
- The backend server on port 3001
- The React frontend on port 3000

### First-time Use

1. Navigate to `http://localhost:3000` in your browser
2. Click "Login with Google" and authorize the application
3. Once authenticated, you'll see the booking interface
4. Others can now use the application to book time with you

## Deployment

The application is set up for easy deployment to Heroku:

```
heroku create
git push heroku main
```

Make sure to set your environment variables in Heroku:

```
heroku config:set GOOGLE_CLIENT_ID=your_client_id
heroku config:set GOOGLE_CLIENT_SECRET=your_client_secret
heroku config:set GOOGLE_REDIRECT_URL=https://your-app-name.herokuapp.com/auth/google/callback
heroku config:set SESSION_SECRET=your_random_secret_string
```

## Project Structure

```
/
├── client/                 # React frontend
│   ├── public/             # Static files
│   └── src/                # React components and styles
├── server.js               # Express server and API
├── package.json            # Server dependencies
└── .env                    # Environment variables
```