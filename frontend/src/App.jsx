import React, { useState, useEffect } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:30001/api';

let stripePromise = null;
function getStripePromise() {
  if (!stripePromise) {
    stripePromise = fetch(`${API_URL}/payments/config`)
      .then((r) => r.json())
      .then((d) => (d.publishableKey ? loadStripe(d.publishableKey) : null))
      .catch(() => null);
  }
  return stripePromise;
}

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

// Checkout form rendered inside <Elements>. Handles confirming the payment
// with Stripe and then telling our backend to finalize the order.
function CheckoutForm({ orderId, amount, currency, onSuccess, onCancel }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handlePay = async () => {
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError('');

    const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
    });

    if (stripeError) {
      setError(stripeError.message || 'Payment failed. Please check your card details and try again.');
      setSubmitting(false);
      return;
    }

    if (paymentIntent && paymentIntent.status === 'succeeded') {
      try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${API_URL}/payments/confirm-payment`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ orderId, paymentIntentId: paymentIntent.id }),
        });
        const data = await response.json();
        if (data.success) {
          onSuccess(data);
        } else {
          setError(data.message || 'Payment succeeded but order confirmation failed. Contact support.');
        }
      } catch (e) {
        setError('Payment succeeded but we could not confirm your order. Contact support with your payment reference.');
      }
    } else {
      setError('Payment requires additional verification. Please try again.');
    }
    setSubmitting(false);
  };

  return (
    <div>
      <PaymentElement />
      {error && (
        <div style={{ marginTop: '12px', padding: '10px', backgroundColor: '#fdecea', color: '#a33', borderRadius: '6px', fontSize: '14px' }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
        <button
          onClick={onCancel}
          disabled={submitting}
          style={{ flex: 1, padding: '12px', cursor: 'pointer', borderRadius: '8px', border: '1px solid #ccc', backgroundColor: 'white' }}>
          Cancel
        </button>
        <button
          onClick={handlePay}
          disabled={!stripe || submitting}
          style={{
            flex: 2,
            padding: '12px',
            cursor: submitting ? 'default' : 'pointer',
            borderRadius: '8px',
            border: 'none',
            backgroundColor: submitting ? '#9bcf9e' : '#4CAF50',
            color: 'white',
            fontWeight: 'bold',
          }}>
          {submitting ? 'Processing...' : `Pay $${Number(amount).toFixed(2)} ${currency || ''}`}
        </button>
      </div>
      <p style={{ fontSize: '12px', color: '#888', marginTop: '10px' }}>
        Test mode — use card number 4242 4242 4242 4242, any future expiry date, any CVC, and any ZIP code.
      </p>
    </div>
  );
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

  // Event detail / ticket purchase state
  const [availableTickets, setAvailableTickets] = useState([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [selectedTicketId, setSelectedTicketId] = useState(null);
  const [checkout, setCheckout] = useState(null); // { clientSecret, orderId, amount, currency }
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [purchaseError, setPurchaseError] = useState('');
  const [purchaseSuccess, setPurchaseSuccess] = useState(null); // { ticketNumber, orderNumber }

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

  // When an event is opened, fetch its available tickets
  useEffect(() => {
    if (!selectedEvent) {
      setAvailableTickets([]);
      setSelectedTicketId(null);
      setCheckout(null);
      setPurchaseSuccess(null);
      setPurchaseError('');
      return;
    }
    const loadTickets = async () => {
      setTicketsLoading(true);
      try {
        const response = await fetch(`${API_URL}/events/${selectedEvent.id}`);
        const data = await response.json();
        const tickets = data.availableTickets || [];
        setAvailableTickets(tickets);
        if (tickets.length > 0) setSelectedTicketId(tickets[0].id);
      } catch (error) {
        setAvailableTickets([]);
      } finally {
        setTicketsLoading(false);
      }
    };
    loadTickets();
  }, [selectedEvent]);

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

  const handleStartCheckout = async () => {
    if (!selectedTicketId || !selectedEvent) return;
    setPurchaseLoading(true);
    setPurchaseError('');
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_URL}/payments/create-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ eventId: selectedEvent.id, ticketId: selectedTicketId, quantity: 1 }),
      });
      const data = await response.json();
      if (data.clientSecret) {
        setCheckout(data);
      } else {
        setPurchaseError(data.error || 'Could not start checkout. Please try again.');
      }
    } catch (error) {
      setPurchaseError('Could not start checkout: ' + error.message);
    } finally {
      setPurchaseLoading(false);
    }
  };

  const selectedTicket = availableTickets.find((t) => t.id === selectedTicketId);

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

          {purchaseSuccess ? (
            <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#e8f5e9', borderRadius: '8px', textAlign: 'center' }}>
              <p style={{ fontSize: '18px', fontWeight: 'bold' }}>✅ Purchase complete!</p>
              <p>Order: {purchaseSuccess.order?.orderNumber}</p>
              <p>Ticket #: {purchaseSuccess.ticketNumber}</p>
              <button onClick={() => setSelectedEvent(null)} style={{ padding: '10px 20px', cursor: 'pointer', marginTop: '10px' }}>
                Back to Events
              </button>
            </div>
          ) : !loggedIn ? (
            <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#fff3cd', borderRadius: '8px' }}>
              <p>👤 Please login to buy tickets</p>
              <button onClick={() => setSelectedEvent(null)} style={{ padding: '10px 20px', cursor: 'pointer' }}>
                Go Back & Login
              </button>
            </div>
          ) : checkout ? (
            <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#f5f5f5', borderRadius: '8px' }}>
              <h3 style={{ marginTop: 0 }}>Complete Your Purchase</h3>
              <Elements stripe={getStripePromise()} options={{ clientSecret: checkout.clientSecret }}>
                <CheckoutForm
                  orderId={checkout.orderId}
                  amount={checkout.amount}
                  currency={checkout.currency}
                  onCancel={() => setCheckout(null)}
                  onSuccess={(data) => {
                    setPurchaseSuccess(data);
                    setCheckout(null);
                  }}
                />
              </Elements>
            </div>
          ) : (
            <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#f5f5f5', borderRadius: '8px' }}>
              <h3 style={{ marginTop: 0 }}>Select Tickets</h3>
              {ticketsLoading && <p>Loading ticket options...</p>}
              {!ticketsLoading && availableTickets.length === 0 && (
                <p>No tickets currently available for this event.</p>
              )}
              {!ticketsLoading && availableTickets.length > 0 && (
                <div>
                  {availableTickets.map((t) => (
                    <label
                      key={t.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px',
                        marginBottom: '8px',
                        borderRadius: '6px',
                        border: selectedTicketId === t.id ? '2px solid #4CAF50' : '1px solid #ddd',
                        backgroundColor: 'white',
                        cursor: 'pointer',
                      }}>
                      <span>
                        <input
                          type="radio"
                          name="ticket"
                          checked={selectedTicketId === t.id}
                          onChange={() => setSelectedTicketId(t.id)}
                          style={{ marginRight: '10px' }}
                        />
                        {t.ticket_type || 'General Admission'}
                      </span>
                      <strong>${Number(t.price).toFixed(2)}</strong>
                    </label>
                  ))}
                </div>
              )}
              {purchaseError && (
                <div style={{ marginBottom: '10px', padding: '10px', backgroundColor: '#fdecea', color: '#a33', borderRadius: '6px', fontSize: '14px' }}>
                  {purchaseError}
                </div>
              )}
              <button
                onClick={handleStartCheckout}
                disabled={!selectedTicketId || purchaseLoading}
                style={{
                  marginTop: '10px',
                  padding: '15px 30px',
                  fontSize: '16px',
                  backgroundColor: !selectedTicketId || purchaseLoading ? '#9bcf9e' : '#4CAF50',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: !selectedTicketId || purchaseLoading ? 'default' : 'pointer',
                  width: '100%'
                }}>
                {purchaseLoading ? 'Starting checkout...' : '🛒 Buy Ticket'}
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
