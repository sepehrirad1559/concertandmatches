import React, { useState, useEffect } from 'react';
import { useAuth } from "../contexts/AuthContext";

export const ProfilePage = () => {
  const { user, token, logout } = useAuth();
  const [activeTab, setActiveTab] = useState('profile');
  const [formData, setFormData] = useState({
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    phone: '',
    country: '',
    state: '',
    city: '',
    address: ''
  });
  const [orders, setOrders] = useState([]);
  const [savedEvents, setSavedEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

  useEffect(() => {
    if (activeTab === 'orders') {
      fetchOrders();
    } else if (activeTab === 'saved') {
      fetchSavedEvents();
    }
  }, [activeTab]);

  const fetchOrders = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/orders`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      setOrders(data.orders);
    } catch (err) {
      console.error('Failed to fetch orders:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchSavedEvents = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/users/saved-events`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      setSavedEvents(data.savedEvents);
    } catch (err) {
      console.error('Failed to fetch saved events:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleProfileUpdate = async (e) => {
    e.preventDefault();
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/users/profile`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(formData)
      });

      if (response.ok) {
        setMessage('Profile updated successfully!');
        setTimeout(() => setMessage(null), 3000);
      }
    } catch (err) {
      setMessage('Failed to update profile');
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  return (
    <div className="profile-container">
      <div className="profile-sidebar">
        <div className="user-header">
          <div className="avatar">{user?.firstName?.[0]}</div>
          <div className="user-info">
            <h2>{user?.firstName} {user?.lastName}</h2>
            <p>{user?.email}</p>
          </div>
        </div>

        <nav className="profile-nav">
          <button 
            className={`nav-item ${activeTab === 'profile' ? 'active' : ''}`}
            onClick={() => setActiveTab('profile')}
          >
            👤 Profile
          </button>
          <button 
            className={`nav-item ${activeTab === 'orders' ? 'active' : ''}`}
            onClick={() => setActiveTab('orders')}
          >
            🎫 My Tickets
          </button>
          <button 
            className={`nav-item ${activeTab === 'saved' ? 'active' : ''}`}
            onClick={() => setActiveTab('saved')}
          >
            ❤️ Saved Events
          </button>
          <button 
            className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            ⚙️ Settings
          </button>
        </nav>

        <button className="btn-logout" onClick={logout}>
          Logout
        </button>
      </div>

      <div className="profile-content">
        {message && <div className="success-message">{message}</div>}

        {/* Profile Tab */}
        {activeTab === 'profile' && (
          <div className="profile-tab">
            <h1>Profile Information</h1>
            <form onSubmit={handleProfileUpdate}>
              <div className="form-row">
                <div className="form-group">
                  <label>First Name</label>
                  <input
                    type="text"
                    name="firstName"
                    value={formData.firstName}
                    onChange={handleInputChange}
                  />
                </div>
                <div className="form-group">
                  <label>Last Name</label>
                  <input
                    type="text"
                    name="lastName"
                    value={formData.lastName}
                    onChange={handleInputChange}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Phone</label>
                <input
                  type="tel"
                  name="phone"
                  value={formData.phone}
                  onChange={handleInputChange}
                  placeholder="(555) 123-4567"
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Country</label>
                  <input
                    type="text"
                    name="country"
                    value={formData.country}
                    onChange={handleInputChange}
                  />
                </div>
                <div className="form-group">
                  <label>State</label>
                  <input
                    type="text"
                    name="state"
                    value={formData.state}
                    onChange={handleInputChange}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>City</label>
                <input
                  type="text"
                  name="city"
                  value={formData.city}
                  onChange={handleInputChange}
                />
              </div>

              <div className="form-group">
                <label>Address</label>
                <input
                  type="text"
                  name="address"
                  value={formData.address}
                  onChange={handleInputChange}
                />
              </div>

              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Saving...' : 'Save Changes'}
              </button>
            </form>
          </div>
        )}

        {/* Orders Tab */}
        {activeTab === 'orders' && (
          <div className="orders-tab">
            <h1>My Tickets</h1>
            {loading ? (
              <p>Loading...</p>
            ) : orders.length === 0 ? (
              <p>No tickets purchased yet</p>
            ) : (
              <div className="orders-list">
                {orders.map(order => (
                  <div key={order.id} className="order-card">
                    <div className="order-info">
                      <h3>{order.event_title}</h3>
                      <p className="order-number">Order #{order.order_number}</p>
                      <p className="date">📅 {new Date(order.event_date).toLocaleDateString()}</p>
                      <p className="location">📍 {order.city}, {order.state}</p>
                    </div>
                    <div className="order-status">
                      <span className={`status ${order.status}`}>{order.status}</span>
                      <p className="price">${order.total_price}</p>
                      {order.ticket_number && (
                        <p className="ticket-number">🎫 {order.ticket_number}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Saved Events Tab */}
        {activeTab === 'saved' && (
          <div className="saved-tab">
            <h1>Saved Events</h1>
            {loading ? (
              <p>Loading...</p>
            ) : savedEvents.length === 0 ? (
              <p>No saved events yet</p>
            ) : (
              <div className="saved-events-grid">
                {savedEvents.map(event => (
                  <div key={event.id} className="saved-event-card">
                    <h3>{event.title}</h3>
                    <p className="category">{event.category}</p>
                    <p className="date">📅 {new Date(event.date).toLocaleDateString()}</p>
                    <p className="location">📍 {event.city}, {event.state}</p>
                    <p className="price-range">${event.min_price?.toFixed(2)} - ${event.max_price?.toFixed(2)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === 'settings' && (
          <div className="settings-tab">
            <h1>Settings</h1>
            <div className="settings-section">
              <h3>Change Password</h3>
              <p>Coming soon...</p>
            </div>
            <div className="settings-section">
              <h3>Privacy Settings</h3>
              <p>Coming soon...</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
