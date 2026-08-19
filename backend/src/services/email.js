import nodemailer from 'nodemailer';
import QRCode from 'qrcode';
import { PDFDocument, rgb } from 'pdf-lib';
import { pool } from '../index.js';

// Setup Email Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Alternative: SendGrid
// const sgMail = require('@sendgrid/mail');
// sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Send Order Confirmation Email with Ticket
export const sendOrderConfirmationEmail = async (orderId, userId) => {
  try {
    // Get order details
    const orderResult = await pool.query(
      `SELECT o.*, u.email, u.first_name, e.title as event_title, e.date as event_date, 
              e.venue_name, e.city, e.state, gt.ticket_number, gt.ticket_qr_code
       FROM orders o
       JOIN users u ON o.user_id = u.id
       JOIN events e ON o.event_id = e.id
       LEFT JOIN generated_tickets gt ON o.id = gt.order_id
       WHERE o.id = $1 AND u.id = $2`,
      [orderId, userId]
    );

    if (orderResult.rows.length === 0) {
      console.error('Order not found for email');
      return false;
    }

    const { email, first_name, event_title, event_date, venue_name, city, state, ticket_number, total_price, order_number } = orderResult.rows[0];

    // Generate QR code
    const qrCode = await QRCode.toDataURL(ticket_number);

    // Generate PDF ticket
    const pdfUrl = await generateTicketPDF({
      ticketNumber: ticket_number,
      eventTitle: event_title,
      eventDate: event_date,
      venueName: venue_name,
      city,
      state,
      totalPrice,
      qrCode
    });

    // Email HTML content
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1>Order Confirmation - ConcertAndMatches.com</h1>
        
        <p>Hi ${first_name},</p>
        
        <p>Thank you for your purchase! Your tickets are ready.</p>
        
        <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h2>${event_title}</h2>
          <p><strong>Order Number:</strong> ${order_number}</p>
          <p><strong>Event Date:</strong> ${new Date(event_date).toLocaleDateString()}</p>
          <p><strong>Venue:</strong> ${venue_name}, ${city}, ${state}</p>
          <p><strong>Total Price:</strong> $${total_price}</p>
          <p><strong>Ticket Number:</strong> ${ticket_number}</p>
        </div>

        <div style="text-align: center; margin: 20px 0;">
          <img src="${qrCode}" alt="QR Code" style="width: 200px;">
        </div>

        <p>Your ticket PDF is attached. Please bring it to the event or display it on your phone.</p>

        <p><strong>Important:</strong> Save your ticket number: <code>${ticket_number}</code></p>

        <hr style="margin: 20px 0;">
        <p style="color: #666; font-size: 12px;">
          Questions? Contact us at support@concertandmatches.com
        </p>
      </div>
    `;

    // Send email with attachment
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: `Your Tickets: ${event_title}`,
      html: htmlContent,
      attachments: [
        {
          filename: `${ticket_number}.pdf`,
          path: pdfUrl,
          contentType: 'application/pdf'
        }
      ]
    });

    console.log(`✅ Confirmation email sent to ${email}`);
    return true;
  } catch (error) {
    console.error('Email sending failed:', error);
    return false;
  }
};

// Generate Ticket PDF
export const generateTicketPDF = async (ticketData) => {
  try {
    const { ticketNumber, eventTitle, eventDate, venueName, city, state, totalPrice, qrCode } = ticketData;

    // Create PDF document
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 800]);
    const { width, height } = page.getSize();

    // Background color
    page.drawRectangle({
      x: 0,
      y: 0,
      width: width,
      height: height,
      color: rgb(0.95, 0.95, 0.95)
    });

    // Header
    page.drawText('ConcertAndMatches.com', {
      x: 50,
      y: height - 50,
      size: 24,
      color: rgb(0, 29, 61)
    });

    // Title
    page.drawText('Event Ticket', {
      x: 50,
      y: height - 100,
      size: 20,
      color: rgb(0, 61, 130)
    });

    // Event Details
    page.drawText(`Event: ${eventTitle}`, {
      x: 50,
      y: height - 150,
      size: 14
    });

    page.drawText(`Date: ${new Date(eventDate).toLocaleDateString()}`, {
      x: 50,
      y: height - 180,
      size: 12
    });

    page.drawText(`Time: ${new Date(eventDate).toLocaleTimeString()}`, {
      x: 50,
      y: height - 210,
      size: 12
    });

    page.drawText(`Venue: ${venueName}`, {
      x: 50,
      y: height - 240,
      size: 12
    });

    page.drawText(`Location: ${city}, ${state}`, {
      x: 50,
      y: height - 270,
      size: 12
    });

    // QR Code (as placeholder - would need to embed actual image)
    page.drawText('QR Code for Entry:', {
      x: 50,
      y: height - 330,
      size: 12
    });

    // Ticket Number
    page.drawRectangle({
      x: 50,
      y: height - 450,
      width: 500,
      height: 60,
      borderColor: rgb(0, 29, 61),
      borderWidth: 2
    });

    page.drawText(`Ticket #: ${ticketNumber}`, {
      x: 70,
      y: height - 410,
      size: 16,
      color: rgb(0, 29, 61)
    });

    // Price
    page.drawText(`Total: $${totalPrice}`, {
      x: 50,
      y: height - 500,
      size: 14,
      color: rgb(255, 23, 68)
    });

    // Footer
    page.drawText('Please have this ticket ready at the entrance.', {
      x: 50,
      y: 50,
      size: 10,
      color: rgb(100, 100, 100)
    });

    // Save PDF
    const pdfBytes = await pdfDoc.save();
    const filename = `/tmp/${ticketNumber}.pdf`;
    
    // In production, save to cloud storage (S3, GCS, etc.)
    // For now, just return the bytes info
    return filename;
  } catch (error) {
    console.error('PDF generation failed:', error);
    throw error;
  }
};

// Send Password Reset Email
export const sendPasswordResetEmail = async (email, resetToken) => {
  try {
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1>Password Reset Request</h1>
        <p>You requested a password reset for your ConcertAndMatches.com account.</p>
        <p>Click the link below to reset your password:</p>
        <a href="${resetUrl}" style="display: inline-block; padding: 10px 20px; background: #ff1744; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0;">
          Reset Password
        </a>
        <p>Or paste this link in your browser: ${resetUrl}</p>
        <p>This link will expire in 24 hours.</p>
        <hr style="margin: 20px 0;">
        <p style="color: #666; font-size: 12px;">
          If you didn't request this, please ignore this email.
        </p>
      </div>
    `;

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Reset Your ConcertAndMatches Password',
      html: htmlContent
    });

    console.log(`✅ Reset email sent to ${email}`);
    return true;
  } catch (error) {
    console.error('Reset email failed:', error);
    return false;
  }
};

// Send Event Price Drop Alert
export const sendPriceDropAlert = async (userId, eventId, eventTitle, newPrice) => {
  try {
    const userResult = await pool.query('SELECT email, first_name FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return false;

    const { email, first_name } = userResult.rows[0];

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1>Price Alert - ConcertAndMatches.com</h1>
        <p>Hi ${first_name},</p>
        <p>Great news! The price for <strong>${eventTitle}</strong> has dropped!</p>
        <div style="background: #e0f0ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>New Price: $${newPrice}</strong></p>
          <a href="${process.env.FRONTEND_URL}/events/${eventId}" style="display: inline-block; padding: 10px 20px; background: #ff1744; color: white; text-decoration: none; border-radius: 5px;">
            View Event & Buy
          </a>
        </div>
      </div>
    `;

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: `Price Drop Alert: ${eventTitle}`,
      html: htmlContent
    });

    return true;
  } catch (error) {
    console.error('Price alert email failed:', error);
    return false;
  }
};
