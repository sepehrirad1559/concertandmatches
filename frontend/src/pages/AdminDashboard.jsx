import React, { useState, useEffect } from 'react';
import { useAuth } from "../contexts/AuthContext";


export const AdminDashboard = () => {
  const { token, user } = useAuth();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [stats, setStats] = useState(null);
  const [orders, setOrders] = useState([]);
  const [users, setUsers] = useState([]);
  const [events, setEvents] = useState([]);
  const [refunds, setRefunds] = useState([]);
  const [loading, setLoading] = useState(false);

  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

  useEffect(() => {
    if (activeTab === 'dashboard') {
      fetchDashboardStats();
    } else if (activeTab === 'orders') {
      fetchOrders();
    } else if (activeTab === 'users') {
      fetchUsers();
    } else if (activeTab === 'events') {
      fetchEvents();
    } else if (activeTab === 'refunds') {
      fetchRefunds();
    }
  }, [activeTab]);

  const fetchDashboardStats = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/admin/dashboard`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      setStats(data.stats);
      setOrders(data.recentOrders);
    } catch (err) {
      console.error('Failed to fetch dashboard:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchOrders = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/admin/orders`, {
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

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/admin/users`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      setUsers(data.users);
    } catch (err) {
      console.error('Failed to fetch users:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchEvents = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/admin/events`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      setEvents(data.events);
    } catch (err) {
      console.error('Failed to fetch events:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchRefunds = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/admin/refunds`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      setRefunds(data.refunds);
    } catch (err) {
      console.error('Failed to fetch refunds:', err);
    } finally {
      setLoading(false);
    }
  };

  if (!user?.isAdmin) {
    return <div className="admin-error">Access Denied: Admin only</div>;
  }

  return (
    <div className="admin-dashboard">
      <div className="admin-sidebar">
        <h1>Admin Panel</h1>
        <nav className="admin-nav">
          <button 
            className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            📊 Dashboard
          </button>
          <button 
            className={`nav-item ${activeTab === 'orders' ? 'active' : ''}`}
            onClick={() => setActiveTab('orders')}
          >
            🛒 Orders
          </button>
          <button 
            className={`nav-item ${activeTab === 'users' ? 'active' : ''}`}
            onClick={() => setActiveTab('users')}
          >
            👥 Users
          </button>
          <button 
            className={`nav-item ${activeTab === 'events' ? 'active' : ''}`}
            onClick={() => setActiveTab('events')}
          >
            🎪 Events
          </button>
          <button 
            className={`nav-item ${activeTab === 'refunds' ? 'active' : ''}`}
            onClick={() => setActiveTab('refunds')}
          >
            💰 Refunds
          </button>
        </nav>
      </div>

      <div className="admin-content">
        {/* Dashboard Tab */}
        {activeTab === 'dashboard' && (
          <div className="dashboard-tab">
            <h1>Dashboard</h1>
            
            {stats && (
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-value">${stats.totalRevenue?.toFixed(2)}</div>
                  <div className="stat-label">Total Revenue</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{stats.totalOrders}</div>
                  <div className="stat-label">Total Orders</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{stats.totalUsers}</div>
                  <div className="stat-label">Total Users</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{stats.totalEvents}</div>
                  <div className="stat-label">Total Events</div>
                </div>
              </div>
            )}

            <h2>Recent Orders</h2>
            <div className="orders-table">
              <table>
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Customer</th>
                    <th>Event</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.slice(0, 10).map(order => (
                    <tr key={order.id}>
                      <td>{order.order_number}</td>
                      <td>{order.email}</td>
                      <td>{order.title}</td>
                      <td>${order.total_price}</td>
                      <td><span className={`status ${order.status}`}>{order.status}</span></td>
                      <td>{new Date(order.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Orders Tab */}
        {activeTab === 'orders' && (
          <div className="orders-tab">
            <h1>Orders Management</h1>
            {loading ? <p>Loading...</p> : (
              <div className="orders-table">
                <table>
                  <thead>
                    <tr>
                      <th>Order #</th>
                      <th>Customer</th>
                      <th>Event</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map(order => (
                      <tr key={order.id}>
                        <td>{order.order_number}</td>
                        <td>{order.email}</td>
                        <td>{order.title}</td>
                        <td>${order.total_price}</td>
                        <td><span className={`status ${order.status}`}>{order.status}</span></td>
                        <td>
                          <button className="btn-small">View</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Users Tab */}
        {activeTab === 'users' && (
          <div className="users-tab">
            <h1>Users Management</h1>
            {loading ? <p>Loading...</p> : (
              <div className="users-table">
                <table>
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Name</th>
                      <th>Joined</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map(u => (
                      <tr key={u.id}>
                        <td>{u.email}</td>
                        <td>{u.first_name} {u.last_name}</td>
                        <td>{new Date(u.created_at).toLocaleDateString()}</td>
                        <td>
                          <button className="btn-small">Details</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Events Tab */}
        {activeTab === 'events' && (
          <div className="events-tab">
            <h1>Events Management</h1>
            {loading ? <p>Loading...</p> : (
              <div className="events-table">
                <table>
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Category</th>
                      <th>Date</th>
                      <th>Location</th>
                      <th>Price Range</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map(event => (
                      <tr key={event.id}>
                        <td>{event.title}</td>
                        <td>{event.category}</td>
                        <td>{new Date(event.date).toLocaleDateString()}</td>
                        <td>{event.city}, {event.state}</td>
                        <td>${event.min_price?.toFixed(2)} - ${event.max_price?.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Refunds Tab */}
        {activeTab === 'refunds' && (
          <div className="refunds-tab">
            <h1>Refund Requests</h1>
            {loading ? <p>Loading...</p> : (
              <div className="refunds-table">
                <table>
                  <thead>
                    <tr>
                      <th>Refund ID</th>
                      <th>Order #</th>
                      <th>Customer</th>
                      <th>Amount</th>
                      <th>Reason</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {refunds.map(refund => (
                      <tr key={refund.id}>
                        <td>#{refund.id}</td>
                        <td>{refund.order_number}</td>
                        <td>{refund.email}</td>
                        <td>${refund.refund_amount?.toFixed(2)}</td>
                        <td>{refund.reason}</td>
                        <td><span className={`status ${refund.status}`}>{refund.status}</span></td>
                        <td>
                          <button className="btn-small">Review</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
