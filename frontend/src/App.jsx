import React, { useState, useEffect } from 'react';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:30001/api';

function formatDate(dateStr) {
  if (!dateStr) return 'Date TBA';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

function formatPrice(event) {
  if (event.min_price == null && event.max_price == null) return 'Price TBA';
  if (event.min_price != null && event.max_price != null && event.min_price !== event.max_price) {
    return `$${Number(event.min_price).toFixed(0)} - $${Number(event.max_price).toFixed(0)}`;
  }
  const p = event.min_price != null ? event.min_price : event.max_price;
  return `$${Number(p).toFixed(0)}`;
}

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [message, setMessage] = useState('');

  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState('');

  useEffect(() => {
    const loadEvents = async () => {
      setEventsLoading(true);
      setEventsError('');
      try {
        const response = await fetch(`${API_URL}/events?limit=24`);
        const data = await response.json();
        setEvents(data.events || []);
      } catch (error) {
        setEventsError('Could not load events right now. Please try again later.');
      } finally {
        setEventsLoading(false);
      }
    };
    loadEvents();
  }, []);

  const handleLogin = async () => {
    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await response.json();
      if (data.token) {
        localStorage.setItem('token', data.token);
        setLoggedIn(true);
        setShowLogin(false);
        setMessage('✅ Login successful!');
        setTimeout(() => setMessage(''), 3000);
      } else {
        setMessage('❌ Login failed: ' + (data.message || 'Invalid credentials'));
      }
    } catch (error) {
      setMessage('❌ Error: ' + error.message);
    }
  };

  const handleRegister = async () => {
    if (!firstName || !lastName || !email || !password) {
      setMessage('❌ All fields required!');
      return;
    }
    try {
      const response = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          passwordConfirm: password,
          firstName,
          lastName
        })
      });
      const data = await response.json();
      if (data.token) {
        localStorage.setItem('token', data.token);
        setLoggedIn(true);
        setShowRegister(false);
        setMessage('✅ Registration successful!');
        setTimeout(() => setMessage(''), 3000);
      } else {
        setMessage('❌ Registration failed: ' + (data.error || 'Unknown error'));
      }
    } catch (error) {
      setMessage('❌ Error: ' + error.message);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setLoggedIn(false);
    setEmail('');
    setPassword('');
    setFirstName('');
    setLastName('');
    setMessage('✅ Logged out!');
    setTimeout(() => setMessage(''), 3000);
  };

  // EVENT DETAIL PAGE
  if (selectedEvent) {
    return (
      <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
        <nav style={{ marginBottom: '20px', display: 'flex', gap: '10px', alignItems: 'center' }}>
          <h2 style={{ margin: '0' }}>ConcertAndMatches.com</h2>
          <button onClick={() => setSelectedEvent(null)} style={{ padding: '8px 16px', cursor: 'pointer' }}>
            ← Back to Events
          </button>
          {loggedIn && (
            <button onClick={handleLogout} style={{ padding: '8px 16px', cursor: 'pointer', marginLeft: 'auto' }}>
              Logout
            </button>
          )}
        </nav>

        <div style={{ maxWidth: '600px', margin: '0 auto', border: '1px solid #ddd', padding: '30px', borderRadius: '8px' }}>
          {selectedEvent.image_url && (
            <img
              src={selectedEvent.image_url}
              alt={selectedEvent.title}
              style={{ width: '100%', borderRadius: '8px', marginBottom: '20px', objectFit: 'cover', maxHeight: '300px' }}
            />
          )}
          <h1>{selectedEvent.title}</h1>
          {selectedEvent.artist_name && (
            <p style={{ fontSize: '18px', color: '#666' }}>{selectedEvent.artist_name}</p>
          )}
          {selectedEvent.description && (
            <p style={{ fontSize: '15px', color: '#666' }}>{selectedEvent.description}</p>
          )}

          <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#f5f5f5', borderRadius: '8px' }}>
            <p><strong>📅 Date:</strong> {formatDate(selectedEvent.date)}</p>
            <p><strong>📍 Location:</strong> {selectedEvent.venue_name ? `${selectedEvent.venue_name}, ` : ''}{selectedEvent.city}{selectedEvent.state ? `, ${selectedEvent.state}` : ''}</p>
            <p><strong>💰 Price:</strong> {formatPrice(selectedEvent)}</p>
          </div>

          {loggedIn ? (
            <button style={{
              marginTop: '30px',
              padding: '15px 30px',
              fontSize: '16px',
              backgroundColor: '#4CAF50',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              width: '100%'
            }}>
              🛒 Buy Ticket
            </button>
          ) : (
            <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#fff3cd', borderRadius: '8px' }}>
              <p>👤 Please login to buy tickets</p>
              <button onClick={() => setSelectedEvent(null)} style={{ padding: '10px 20px', cursor: 'pointer' }}>
                Go Back & Login
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // HOME PAGE
  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <nav style={{ marginBottom: '20px', display: 'flex', gap: '10px', alignItems: 'center' }}>
        <h2 style={{ margin: '0' }}>ConcertAndMatches.com</h2>
        {loggedIn ? (
          <button onClick={handleLogout} style={{ padding: '8px 16px', cursor: 'pointer' }}>
            Logout
          </button>
        ) : (
          <>
            <button onClick={() => { setShowLogin(!showLogin); setShowRegister(false); }} style={{ padding: '8px 16px', cursor: 'pointer' }}>
              {showLogin ? 'Close' : 'Login'}
            </button>
            <button onClick={() => { setShowRegister(!showRegister); setShowLogin(false); }} style={{ padding: '8px 16px', cursor: 'pointer', backgroundColor: '#4CAF50', color: 'white' }}>
              {showRegister ? 'Close' : 'Sign Up'}
            </button>
          </>
        )}
      </nav>

      {message && (
        <div style={{ padding: '10px', marginBottom: '20px', backgroundColor: '#f0f0f0', borderRadius: '4px', fontSize: '14px' }}>
          {message}
        </div>
      )}

      {showLogin && (
        <div style={{ border: '1px solid #ccc', padding: '20px', maxWidth: '300px', marginBottom: '20px', borderRadius: '8px' }}>
          <h3>Login</h3>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ display: 'block', width: '100%', marginBottom: '10px', padding: '8px', boxSizing: 'border-box' }}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ display: 'block', width: '100%', marginBottom: '10px', padding: '8px', boxSizing: 'border-box' }}
          />
          <button onClick={handleLogin} style={{ padding: '8px 16px', cursor: 'pointer', width: '100%' }}>
            Login
          </button>
        </div>
      )}

      {showRegister && (
        <div style={{ border: '1px solid #4CAF50', padding: '20px', maxWidth: '300px', marginBottom: '20px', borderRadius: '8px', backgroundColor: '#f9f9f9' }}>
          <h3>Create Account</h3>
          <input
            type="text"
            placeholder="First Name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            style={{ display: 'block', width: '100%', marginBottom: '10px', padding: '8px', boxSizing: 'border-box' }}
          />
          <input
            type="text"
            placeholder="Last Name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            style={{ display: 'block', width: '100%', marginBottom: '10px', padding: '8px', boxSizing: 'border-box' }}
          />
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ display: 'block', width: '100%', marginBottom: '10px', padding: '8px', boxSizing: 'border-box' }}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ display: 'block', width: '100%', marginBottom: '10px', padding: '8px', boxSizing: 'border-box' }}
          />
          <button onClick={handleRegister} style={{ padding: '8px 16px', cursor: 'pointer', width: '100%', backgroundColor: '#4CAF50', color: 'white' }}>
            Sign Up
          </button>
        </div>
      )}

      <div style={{ marginTop: '20px' }}>
        <h2>Status: {loggedIn ? '✅ Logged In' : '❌ Not Logged In'}</h2>

        <h3>Featured Events</h3>

        {eventsLoading && <p>Loading events...</p>}
        {!eventsLoading && eventsError && <p>{eventsError}</p>}
        {!eventsLoading && !eventsError && events.length === 0 && <p>No events available right now. Check back soon!</p>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px' }}>
          {events.map((event) => (
            <div key={event.id} style={{ border: '1px solid #ddd', borderRadius: '8px', overflow: 'hidden' }}>
              {event.image_url && (
                <img
                  src={event.image_url}
                  alt={event.title}
                  style={{ width: '100%', height: '150px', objectFit: 'cover' }}
                />
              )}
              <div style={{ padding: '15px' }}>
                <h4>{event.title}</h4>
                <p>📅 {formatDate(event.date)}</p>
                <p>📍 {event.city}{event.state ? `, ${event.state}` : ''}</p>
                <p>💰 {formatPrice(event)}</p>
                <button
                  onClick={() => setSelectedEvent(event)}
                  style={{ padding: '8px 16px', cursor: 'pointer', width: '100%' }}>
                  View Event
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
