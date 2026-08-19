import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from "../contexts/AuthContext";

export const CheckoutPage = () => {
  const { eventId, ticketId } = useParams();
  const { token } = useAuth();
  const navigate = useNavigate();
  const [event, setEvent] = useState(null);
  const [ticket, setTicket] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(true);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [error, setError] = useState(null);
  const [orderData, setOrderData] = useState(null);

  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

  useEffect(() => {
    fetchEventAndTicket();
  }, [eventId, ticketId]);

  const fetchEventAndTicket = async () => {
    try {
      const eventRes = await fetch(`${API_URL}/events/${eventId}`);
      const eventData = await eventRes.json();
      setEvent(eventData.event);

      const ticketRes = await fetch(`${API_URL}/tickets/${ticketId}`);
      const ticketData = await ticketRes.json();
      setTicket(ticketData.ticket);
    } catch (err) {
      setError('Failed to load event details');
    } finally {
      setLoading(false);
    }
  };

  const handleCreatePayment = async () => {
    try {
      setPaymentLoading(true);
      setError(null);

      const response = await fetch(`${API_URL}/payments/create-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          eventId: parseInt(eventId),
          ticketId: parseInt(ticketId),
          quantity: parseInt(quantity)
        })
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error);
        return;
      }

      // Redirect to Stripe Checkout
      // In production, use Stripe.js or Stripe Hosted Checkout
      setOrderData(data);
      
      // TODO: Integrate with Stripe.js/Elements for payment form
      console.log('Payment intent created:', data);
      
    } catch (err) {
      setError(err.message);
    } finally {
      setPaymentLoading(false);
    }
  };

  if (loading) return <div className="loading">Loading event details...</div>;

  if (!event || !ticket) {
    return <div className="error-page">Event or ticket not found</div>;
  }

  const subtotal = ticket.price * quantity;
  const serviceFee = Math.round(subtotal * 0.05 * 100) / 100;
  const total = subtotal + serviceFee;

  return (
    <div className="checkout-container">
      <div className="checkout-content">
        {/* Order Summary */}
        <div className="order-summary">
          <h1>Order Summary</h1>
          
          <div className="event-summary">
            <h2>{event.title}</h2>
            <p className="date">{new Date(event.date).toLocaleDateString()}</p>
            <p className="venue">{event.venue_name}, {event.city}, {event.state}</p>
          </div>

          <div className="ticket-summary">
            <p><strong>Ticket Type:</strong> {ticket.ticket_type}</p>
            <p><strong>Section:</strong> {ticket.section} | <strong>Row:</strong> {ticket.row_number}</p>
          </div>

          <div className="quantity-selector">
            <label>Quantity:</label>
            <select value={quantity} onChange={(e) => setQuantity(e.target.value)}>
              {[1, 2, 3, 4, 5].map(q => <option key={q} value={q}>{q}</option>)}
            </select>
          </div>

          <div className="price-breakdown">
            <div className="price-row">
              <span>Ticket Price:</span>
              <span>${ticket.price.toFixed(2)} × {quantity}</span>
              <span className="total">${subtotal.toFixed(2)}</span>
            </div>
            <div className="price-row">
              <span>Service Fee (5%):</span>
              <span>${serviceFee.toFixed(2)}</span>
            </div>
            <div className="price-row total-row">
              <span><strong>Total:</strong></span>
              <span><strong>${total.toFixed(2)}</strong></span>
            </div>
          </div>
        </div>

        {/* Payment Form */}
        <div className="payment-form">
          <h2>Payment Information</h2>

          {error && <div className="error-message">{error}</div>}

          {orderData ? (
            <div className="payment-processing">
              <p>Payment intent created. Redirecting to Stripe...</p>
              <p className="order-number">Order #: {orderData.orderNumber}</p>
              
              {/* TODO: Stripe Embedded Payment Form */}
              <div id="payment-element"></div>
              <button className="btn-primary" disabled={paymentLoading}>
                Complete Payment
              </button>
            </div>
          ) : (
            <button 
              className="btn-primary"
              onClick={handleCreatePayment}
              disabled={paymentLoading}
            >
              {paymentLoading ? 'Processing...' : `Continue to Payment ($${total.toFixed(2)})`}
            </button>
          )}

          <div className="security-note">
            <p>🔒 Your payment is secure and encrypted with Stripe</p>
          </div>
        </div>
      </div>
    </div>
  );
};
