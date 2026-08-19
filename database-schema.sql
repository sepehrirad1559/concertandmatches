-- Create Users Table
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  phone VARCHAR(20),
  date_of_birth DATE,
  country VARCHAR(100),
  state VARCHAR(100),
  city VARCHAR(100),
  address VARCHAR(255),
  zip_code VARCHAR(20),
  is_admin BOOLEAN DEFAULT false,
  email_verified BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Events Table
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  external_id VARCHAR(255) UNIQUE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(50),
  artist_name VARCHAR(255),
  date TIMESTAMP NOT NULL,
  end_date TIMESTAMP,
  country VARCHAR(100) NOT NULL,
  state VARCHAR(100) NOT NULL,
  city VARCHAR(100) NOT NULL,
  venue_name VARCHAR(255),
  venue_address VARCHAR(255),
  image_url TEXT,
  source VARCHAR(100),
  source_url TEXT,
  min_price DECIMAL(10, 2),
  max_price DECIMAL(10, 2),
  currency VARCHAR(3) DEFAULT 'USD',
  total_tickets INT DEFAULT 0,
  available_tickets INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_date (date),
  INDEX idx_city (city),
  INDEX idx_state (state),
  INDEX idx_category (category)
);

-- Create Tickets Table
CREATE TABLE tickets (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  external_id VARCHAR(255),
  ticket_type VARCHAR(100),
  section VARCHAR(50),
  row_number VARCHAR(10),
  seat_number VARCHAR(10),
  price DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  marketplace VARCHAR(100),
  marketplace_url TEXT,
  availability_status VARCHAR(50),
  is_sold BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_event (event_id),
  INDEX idx_sold (is_sold)
);

-- Create Orders Table
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INT NOT NULL REFERENCES events(id),
  ticket_id INT NOT NULL REFERENCES tickets(id),
  order_number VARCHAR(50) UNIQUE NOT NULL,
  quantity INT DEFAULT 1,
  subtotal DECIMAL(10, 2) NOT NULL,
  service_fee DECIMAL(10, 2) DEFAULT 0,
  total_price DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  status VARCHAR(50) DEFAULT 'pending',
  payment_method VARCHAR(50),
  stripe_payment_id VARCHAR(255),
  purchased_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_event (event_id),
  INDEX idx_status (status),
  INDEX idx_date (created_at)
);

-- Create Payments Table
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  stripe_payment_intent_id VARCHAR(255) UNIQUE,
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  status VARCHAR(50) DEFAULT 'pending',
  payment_method VARCHAR(100),
  card_last_four VARCHAR(4),
  error_message TEXT,
  processed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_order (order_id),
  INDEX idx_status (status)
);

-- Create Tickets Generated Table (for storing PDF tickets)
CREATE TABLE generated_tickets (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  ticket_qr_code TEXT,
  ticket_pdf_url TEXT,
  ticket_number VARCHAR(50) UNIQUE,
  is_used BOOLEAN DEFAULT false,
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_order (order_id)
);

-- Create Saved Events Table (Watchlist)
CREATE TABLE saved_events (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, event_id)
);

-- Create Price History Table (for analytics)
CREATE TABLE price_history (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ticket_id INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  price DECIMAL(10, 2) NOT NULL,
  marketplace VARCHAR(100),
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_event (event_id),
  INDEX idx_date (recorded_at)
);

-- Create Refund Requests Table
CREATE TABLE refund_requests (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  refund_amount DECIMAL(10, 2),
  processed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_order (order_id),
  INDEX idx_status (status)
);

-- Create Admin Logs Table
CREATE TABLE admin_logs (
  id SERIAL PRIMARY KEY,
  admin_id INT NOT NULL REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  details TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin (admin_id),
  INDEX idx_date (created_at)
);

-- Create Indexes for Performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_events_title ON events(title);
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at);
CREATE INDEX idx_tickets_available ON tickets(event_id, is_sold);
