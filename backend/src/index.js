import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import 'express-async-errors';
import { Pool } from 'pg';

// Routes
import eventsRoutes from './routes/events.js';
import adminRoutes from './routes/admin.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database Connection
export const pool = new Pool({
user: process.env.DB_USER || 'eventflow',
host: process.env.DB_HOST || 'localhost',
database: process.env.DB_NAME || 'eventflow',
password: process.env.DB_PASSWORD || 'eventflow',
port: process.env.DB_PORT || 5432,
});

// Middleware
app.use(helmet());

// Allow the app's known frontend origins (custom domain + www + Vercel
// subdomain), plus whatever FRONTEND_URL is set to in the environment.
// This avoids breaking the site every time a new domain gets added.
const allowedOrigins = [
process.env.FRONTEND_URL,
'http://localhost:5173',
'https://concertandmatches.vercel.app',
'https://concertandmatches.com',
'https://www.concertandmatches.com',
].filter(Boolean);

app.use(cors({
origin: (origin, callback) => {
// Allow requests with no origin (server-to-server, curl, health checks)
if (!origin || allowedOrigins.includes(origin)) {
callback(null, true);
} else {
callback(new Error('Not allowed by CORS'));
}
},
credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Rate Limiting
const limiter = rateLimit({
windowMs: 15 * 60 * 1000,
max: 100,
message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Health Check
app.get('/api/health', (req, res) => {
res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/events', eventsRoutes);
app.use('/api/admin', adminRoutes);

// 404 Handler
app.use((req, res) => {
res.status(404).json({ error: 'Route not found' });
});

// Error Handler
app.use((err, req, res, next) => {
console.error('Error:', err);
res.status(err.status || 500).json({
error: err.message || 'Internal Server Error',
status: err.status || 500
});
});

// Start Server
app.listen(PORT, () => {
console.log(`✅ Server running on port ${PORT}`);
console.log(`🌐 Allowed origins: ${allowedOrigins.join(', ')}`);
console.log(`📦 Database: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`);
});
