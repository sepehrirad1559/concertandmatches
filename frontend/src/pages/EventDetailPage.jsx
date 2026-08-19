import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from "../contexts/AuthContext";


export const EventDetailPage = () => {
  const { eventId } = useParams();
  const { token } = useAuth();
  const navigate = useNavigate();
  const [event, setEvent] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savedEvent, setSavedEvent] = useState(false);

  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

  useEffect(() => {
    fetchEventDetails();
  }, [eventId]);

  const fetchEventDetails = async () => {
    try {
      const response = await fetch(`${API_URL}/events/${eventId}`);
      const data = await response.json();
      setEvent(data.event);
      setTickets(data.availableTickets);
    } catch (err) {
      setError('Failed to load event details');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveEvent = async () => {
    if (!token) {
      navigate('/login');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/events/${eventId}/save`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        setSavedEvent(true);
      }
    } catch (err) {
      console.error('Failed to save event:', err);
    }
  };

  const handleBuyTicket = (ticketId) => {
    if (!token) {
      navigate('/login');
      return;
    }
    navigate(`/checkout/${eventId}/${ticketId}`);
  };

  if (loading) return <div className="loading">Loading event...</div>;
  if (!event) return <div className="error-page">Event not found</div>;

  return (
    <div className="event-detail-page">
      <div className="event-header">
        <img src={event.image_url} alt={event.title} className="event-image" />
        
        <div className="event-info">
          <h1>{event.title}</h1>
          
          <div className="event-meta">
            <span className="category">{event.category}</span>
            <span className="date">📅 {new Date(event.date).toLocaleDateString('en-US', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            })}</span>
          </div>

          <div className="venue-info">
            <p><strong>Venue:</strong> {event.venue_name}</p>
            <p><strong>Location:</strong> {event.city}, {event.state}</p>
          </div>

          <div className="price-range">
            <span className="price-label">Price Range:</span>
            <span className="price">${event.min_price?.toFixed(2)} - ${event.max_price?.toFixed(2)}</span>
          </div>

          <button 
            className={`btn-save ${savedEvent ? 'saved' : ''}`}
            onClick={handleSaveEvent}
            disabled={savedEvent}
          >
            {savedEvent ? '❤️ Saved' : '🤍 Save Event'}
          </button>
        </div>
      </div>

      <div className="tickets-section">
        <h2>Available Tickets</h2>

        {error && <div className="error-message">{error}</div>}

        {tickets.length === 0 ? (
          <div className="no-tickets">
            <p>No tickets currently available for this event.</p>
            <p>Check back soon!</p>
          </div>
        ) : (
          <div className="tickets-grid">
            {tickets.map(ticket => (
              <div key={ticket.id} className="ticket-card">
                <div className="ticket-header">
                  <span className="ticket-type">{ticket.ticket_type}</span>
                  <span className="section">Sec {ticket.section}</span>
                </div>

                <div className="ticket-details">
                  <p>Row {ticket.row_number} • Seat {ticket.seat_number}</p>
                  <p className="marketplace">{ticket.marketplace}</p>
                </div>

                <div className="ticket-price">
                  <span className="price">${ticket.price.toFixed(2)}</span>
                </div>

                <button 
                  className="btn-primary"
                  onClick={() => handleBuyTicket(ticket.id)}
                >
                  Buy Ticket
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {event.description && (
        <div className="event-description">
          <h3>About This Event</h3>
          <p>{event.description}</p>
        </div>
      )}
    </div>
  );
};
