import express from 'express';
import Stripe from 'stripe';
import { pool } from '../index.js';
import { verifyToken, getUserInfo } from '../middleware/auth.js';
import { generateOrderNumber } from '../utils/validation.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_demo');

// Create Payment Intent
router.post('/create-payment', verifyToken, getUserInfo, async (req, res) => {
  try {
    const { eventId, ticketId, quantity = 1 } = req.body;
    const userId = req.userId;

    if (!eventId || !ticketId) {
      return res.status(400).json({ error: 'Event and ticket are required' });
    }

    // Get event
    const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Get ticket
    const ticketResult = await pool.query('SELECT * FROM tickets WHERE id = $1 AND is_sold = false', [ticketId]);
    if (ticketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not available' });
    }

    const ticket = ticketResult.rows[0];
    const event = eventResult.rows[0];

    // Calculate amounts
    const subtotal = ticket.price * quantity;
    const serviceFee = Math.round(subtotal * 0.05); // 5% service fee
    const totalAmount = subtotal + serviceFee;

    // Create payment intent with Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(totalAmount * 100), // Stripe uses cents
      currency: ticket.currency.toLowerCase(),
      payment_method_types: ['card'],
      metadata: {
        userId,
        eventId,
        ticketId,
        quantity
      }
    });

    // Create order record
    const orderNumber = generateOrderNumber();
    const orderResult = await pool.query(
      `INSERT INTO orders (user_id, event_id, ticket_id, order_number, quantity, subtotal, service_fee, total_price, currency, status, stripe_payment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [userId, eventId, ticketId, orderNumber, quantity, subtotal / 100, serviceFee / 100, totalAmount / 100, ticket.currency, 'pending', paymentIntent.id]
    );

    // Create payment record
    await pool.query(
      `INSERT INTO payments (order_id, stripe_payment_intent_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderResult.rows[0].id, paymentIntent.id, totalAmount / 100, ticket.currency, 'pending']
    );

    res.json({
      clientSecret: paymentIntent.client_secret,
      orderId: orderResult.rows[0].id,
      orderNumber,
      amount: totalAmount / 100,
      currency: ticket.currency
    });
  } catch (error) {
    console.error('Payment creation error:', error);
    res.status(500).json({ error: error.message || 'Payment creation failed' });
  }
});

// Confirm Payment
router.post('/confirm-payment', verifyToken, getUserInfo, async (req, res) => {
  try {
    const { orderId, paymentIntentId } = req.body;
    const userId = req.userId;

    if (!orderId || !paymentIntentId) {
      return res.status(400).json({ error: 'Order and payment intent are required' });
    }

    // Verify order belongs to user
    const orderResult = await pool.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [orderId, userId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    // Check payment intent status with Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status === 'succeeded') {
      // Update order status
      await pool.query(
        'UPDATE orders SET status = $1, purchased_at = NOW() WHERE id = $2',
        ['completed', orderId]
      );

      // Update payment record
      await pool.query(
        'UPDATE payments SET status = $1, processed_at = NOW() WHERE stripe_payment_intent_id = $2',
        ['completed', paymentIntentId]
      );

      // Mark ticket as sold
      await pool.query(
        'UPDATE tickets SET is_sold = true WHERE id = $1',
        [order.ticket_id]
      );

      // Generate ticket (PDF, QR code)
      const ticketNumber = `TKT-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      await pool.query(
        `INSERT INTO generated_tickets (order_id, ticket_number, is_used)
         VALUES ($1, $2, $3)`,
        [orderId, ticketNumber, false]
      );

      res.json({
        success: true,
        message: 'Payment completed successfully',
        order: {
          id: order.id,
          orderNumber: order.order_number,
          totalPrice: order.total_price,
          status: 'completed'
        },
        ticketNumber
      });
    } else if (paymentIntent.status === 'requires_action') {
      res.json({
        success: false,
        message: 'Additional authentication required',
        status: 'requires_action'
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Payment failed',
        status: paymentIntent.status
      });
    }
  } catch (error) {
    console.error('Payment confirmation error:', error);
    res.status(500).json({ error: error.message || 'Payment confirmation failed' });
  }
});

// Get Payment History
router.get('/history', verifyToken, getUserInfo, async (req, res) => {
  try {
    const userId = req.userId;
    const { limit = 10, offset = 0 } = req.query;

    const result = await pool.query(
      `SELECT o.*, e.title as event_title, e.date as event_date, gt.ticket_number
       FROM orders o
       JOIN events e ON o.event_id = e.id
       LEFT JOIN generated_tickets gt ON o.id = gt.order_id
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, parseInt(limit), parseInt(offset)]
    );

    res.json({ payments: result.rows });
  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

// Request Refund
router.post('/request-refund', verifyToken, getUserInfo, async (req, res) => {
  try {
    const { orderId, reason } = req.body;
    const userId = req.userId;

    if (!orderId || !reason) {
      return res.status(400).json({ error: 'Order ID and reason are required' });
    }

    // Verify order belongs to user
    const orderResult = await pool.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [orderId, userId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    // Create refund request
    const refundResult = await pool.query(
      `INSERT INTO refund_requests (order_id, user_id, reason, refund_amount, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [orderId, userId, reason, order.total_price, 'pending']
    );

    res.json({
      message: 'Refund request submitted',
      refundId: refundResult.rows[0].id,
      status: 'pending'
    });
  } catch (error) {
    console.error('Refund request error:', error);
    res.status(500).json({ error: 'Refund request failed' });
  }
});

// Webhook for Stripe Events
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_demo'
    );

    switch (event.type) {
      case 'payment_intent.succeeded':
        console.log('Payment succeeded:', event.data.object);
        break;
      case 'payment_intent.payment_failed':
        console.log('Payment failed:', event.data.object);
        break;
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).json({ error: 'Webhook failed' });
  }
});

export default router;
