// API configuration and utilities

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

// Create fetch wrapper with auth headers
export const apiFetch = async (endpoint, options = {}) => {
  const token = localStorage.getItem('token');
  
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers
  });

  if (!response.ok) {
    if (response.status === 401) {
      // Token expired, logout
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    throw new Error(`API Error: ${response.statusText}`);
  }

  return response.json();
};

// Event API calls
export const eventsAPI = {
  getAll: (params) => apiFetch(`/events?${new URLSearchParams(params)}`),
  getById: (id) => apiFetch(`/events/${id}`),
  search: (query) => apiFetch(`/events/search/advanced?q=${query}`),
  save: (eventId) => apiFetch(`/events/${eventId}/save`, { method: 'POST' }),
  getSaved: () => apiFetch('/events/user/saved')
};

// Orders API calls
export const ordersAPI = {
  getAll: (params) => apiFetch(`/orders?${new URLSearchParams(params)}`),
  getById: (id) => apiFetch(`/orders/${id}`),
  cancel: (id) => apiFetch(`/orders/${id}/cancel`, { method: 'POST' }),
  downloadTicket: (id) => apiFetch(`/orders/${id}/download-ticket`)
};

// Payments API calls
export const paymentsAPI = {
  createPayment: (data) => apiFetch('/payments/create-payment', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  confirmPayment: (data) => apiFetch('/payments/confirm-payment', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  getHistory: (params) => apiFetch(`/payments/history?${new URLSearchParams(params)}`),
  requestRefund: (data) => apiFetch('/payments/request-refund', {
    method: 'POST',
    body: JSON.stringify(data)
  })
};

// Users API calls
export const usersAPI = {
  getProfile: () => apiFetch('/users/profile'),
  updateProfile: (data) => apiFetch('/users/profile', {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  changePassword: (data) => apiFetch('/users/change-password', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  getTickets: () => apiFetch('/users/my-tickets'),
  getSavedEvents: () => apiFetch('/users/saved-events'),
  removeSavedEvent: (eventId) => apiFetch(`/users/saved-events/${eventId}`, {
    method: 'DELETE'
  })
};

// Admin API calls
export const adminAPI = {
  getDashboard: () => apiFetch('/admin/dashboard'),
  getOrders: (params) => apiFetch(`/admin/orders?${new URLSearchParams(params)}`),
  getUsers: (params) => apiFetch(`/admin/users?${new URLSearchParams(params)}`),
  getEvents: (params) => apiFetch(`/admin/events?${new URLSearchParams(params)}`),
  getRefunds: (params) => apiFetch(`/admin/refunds?${new URLSearchParams(params)}`),
  approveRefund: (id) => apiFetch(`/admin/refunds/${id}/approve`, { method: 'POST' }),
  rejectRefund: (id) => apiFetch(`/admin/refunds/${id}/reject`, { method: 'POST' }),
  getAnalytics: () => apiFetch('/admin/analytics/revenue'),
  banUser: (userId) => apiFetch(`/admin/users/${userId}/ban`, { method: 'POST' })
};

// Tickets API calls
export const ticketsAPI = {
  getByEvent: (eventId, params) => apiFetch(`/tickets/event/${eventId}?${new URLSearchParams(params)}`),
  getById: (id) => apiFetch(`/tickets/${id}`)
};

// Format currency
export const formatCurrency = (amount, currency = 'USD') => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency
  }).format(amount);
};

// Format date
export const formatDate = (date) => {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

// Format time until event
export const getTimeUntilEvent = (eventDate) => {
  const now = new Date();
  const event = new Date(eventDate);
  const diffMs = event - now;
  
  if (diffMs < 0) return 'Event passed';
  
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  
  if (diffDays > 0) return `${diffDays}d ${diffHours}h left`;
  return `${diffHours}h left`;
};
