// App.js
import React, { useState, useEffect } from 'react';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import axios from 'axios';
import './App.css';
import moment from 'moment-timezone';

function App() {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [availableSlots, setAvailableSlots] = useState([]);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [isAppReady, setIsAppReady] = useState(false);
  const [adminNotAuthenticated, setAdminNotAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [bookingSuccess, setBookingSuccess] = useState(false);
  const [userTimezone, setUserTimezone] = useState(moment.tz.guess());
  const [timezones, setTimezones] = useState([]);
  
  // Get list of common timezones
  useEffect(() => {
    const commonTimezones = [
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'America/Phoenix',
      'America/Anchorage',
      'America/Honolulu',
      'Europe/London',
      'Europe/Paris',
      'Europe/Berlin',
      'Asia/Tokyo',
      'Asia/Shanghai',
      'Australia/Sydney',
      'Pacific/Auckland'
    ];
    
    // Add user's local timezone if not in the list
    const detectedTimezone = moment.tz.guess();
    if (!commonTimezones.includes(detectedTimezone)) {
      commonTimezones.unshift(detectedTimezone);
    }
    
    setTimezones(commonTimezones);
  }, []);
  
  // Check if admin is authenticated
  useEffect(() => {
    const checkAdminAuth = async () => {
      try {
        const response = await axios.get('http://localhost:3001/api/check-admin-auth');
        if (response.data.authenticated) {
          setIsAppReady(true);
        } else {
          setAdminNotAuthenticated(true);
        }
      } catch (error) {
        console.error('Error checking admin auth:', error);
        setAdminNotAuthenticated(true);
      }
    };
    
    checkAdminAuth();
  }, []);
  
  // Fetch available slots when date changes
  useEffect(() => {
    if (isAppReady && selectedDate) {
      fetchAvailableSlots();
    }
  }, [isAppReady, selectedDate, userTimezone]);
  
  const fetchAvailableSlots = async () => {
    setIsLoading(true);
    try {
      // Format date as YYYY-MM-DD to ensure consistency across timezones
      const formattedDate = selectedDate.toISOString().split('T')[0];
      console.log(`Fetching slots for date: ${formattedDate}, timezone: ${userTimezone}`);
      
      const response = await axios.get('http://localhost:3001/api/available-slots', {
        params: {
          date: formattedDate,
          timezone: userTimezone
        }
      });
      setAvailableSlots(response.data);
    } catch (error) {
      console.error('Error fetching slots:', error);
      setAvailableSlots([]);
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleDateChange = (date) => {
    setSelectedDate(date);
    setSelectedSlot(null);
  };
  
  const handleTimezoneChange = (e) => {
    setUserTimezone(e.target.value);
    setSelectedSlot(null);
  };
  
  const handleSlotSelect = (slot) => {
    setSelectedSlot(slot);
  };
  
  const handleBooking = async (e) => {
    e.preventDefault();
    
    if (!selectedSlot || !name || !email) {
      alert('Please fill out all fields');
      return;
    }
    
    setIsLoading(true);
    try {
      await axios.post('http://localhost:3001/api/book', {
        startTime: selectedSlot.start,
        endTime: selectedSlot.end,
        name,
        email,
        timezone: userTimezone
      });
      
      setBookingSuccess(true);
      setName('');
      setEmail('');
      setSelectedSlot(null);
      fetchAvailableSlots();
    } catch (error) {
      console.error('Error booking appointment:', error);
      alert('Failed to book appointment');
    } finally {
      setIsLoading(false);
    }
  };
  
  const formatTime = (isoString) => {
    const date = moment(isoString).tz(userTimezone);
    return date.format('h:mm A'); // Format: 3:30 PM
  };
  
  if (adminNotAuthenticated) {
    return (
      <div className="container">
        <h1>Calendar Setup Required</h1>
        <p>The calendar owner needs to complete initial setup.</p>
        <p>Please ask the administrator to visit:</p>
        <a href="http://localhost:3001/auth/admin" className="admin-link">
          http://localhost:3001/auth/admin
        </a>
        <p>After completing setup, refresh this page.</p>
      </div>
    );
  }
  
  if (!isAppReady) {
    return (
      <div className="container">
        <h1>Loading Calendar...</h1>
        <div className="loading-spinner"></div>
      </div>
    );
  }
  
  return (
    <div className="container">
      <h1>Book a Meeting with Dr. Jacobson</h1>
      <p className="subtitle">Please select a time.</p>
      
      {bookingSuccess && (
        <div className="success-message">
          <p>Booking successful! The appointment has been added to the calendar.</p>
          <p>You'll receive an email confirmation with Zoom meeting details.</p>
          <button onClick={() => setBookingSuccess(false)}>Book Another</button>
        </div>
      )}
      
      {!bookingSuccess && (
        <>
          <div className="date-picker-container">
            <div className="date-timezone-controls">
              <div className="control-group">
                <h2>Select a Date</h2>
                <DatePicker
                  selected={selectedDate}
                  onChange={handleDateChange}
                  minDate={new Date()}
                  dateFormat="MMMM d, yyyy"
                  className="date-picker"
                />
              </div>
              
              <div className="control-group">
                <h2>Your Timezone</h2>
                <select 
                  value={userTimezone} 
                  onChange={handleTimezoneChange}
                  className="timezone-select"
                >
                  {timezones.map(tz => (
                    <option key={tz} value={tz}>
                      {tz.replace(/_/g, ' ')} ({moment().tz(tz).format('z')})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          
          <div className="slots-container">
            <h2>Available Time Slots</h2>
            {isLoading ? (
              <p>Loading available slots...</p>
            ) : availableSlots.length === 0 ? (
              <p>No available slots for this date. Please select another date.</p>
            ) : (
              <div className="slots-grid">
                {availableSlots.map((slot, index) => (
                  <button
                    key={index}
                    className={`slot-button ${selectedSlot === slot ? 'selected' : ''}`}
                    onClick={() => handleSlotSelect(slot)}
                  >
                    {formatTime(slot.start)} - {formatTime(slot.end)}
                  </button>
                ))}
              </div>
            )}
          </div>
          
          {selectedSlot && (
            <div className="booking-form">
              <h2>Book Your Appointment</h2>
              <form onSubmit={handleBooking}>
                <div className="form-group">
                  <label htmlFor="name">Your Name</label>
                  <input
                    type="text"
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="email">Your Email</label>
                  <input
                    type="email"
                    id="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Selected Time</label>
                  <p>
                    {formatTime(selectedSlot.start)} - {formatTime(selectedSlot.end)}
                  </p>
                </div>
                <div className="form-info">
                  <p>You'll receive a confirmation email with Zoom meeting details.</p>
                  <p className="zoom-info">Meeting link: dartmouth.zoom.us/my/jacobsonlab</p>
                </div>
                <button type="submit" className="btn-book" disabled={isLoading}>
                  {isLoading ? 'Booking...' : 'Book Appointment'}
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default App;