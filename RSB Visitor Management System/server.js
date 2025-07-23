require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const app = express()
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');

const dashboardClients = new Set();

// SSE endpoint for dashboard updates
app.get('/api/visitors/updates', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const clientId = Date.now();
  dashboardClients.add(res);
  
  req.on('close', () => {
    dashboardClients.delete(res);
  });
});

function notifyDashboardUpdate() {
  dashboardClients.forEach(client => {
    client.write(`data: update\n\n`);
  });
}


// Database setup
const dbPath = process.env.DB_PATH || './data/visitors.db';
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
    if (err.code === 'SQLITE_CANTOPEN') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Try connecting again after creating directory
      new sqlite3.Database(dbPath, (err) => {
        if (err) {
          console.error('Still unable to open database:', err);
        } else {
          console.log('Created new database at:', dbPath);
          initializeDatabase();
        }
      });
    }
  } else {
    console.log('Connected to SQLite database at:', dbPath);
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS visitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      contact_number TEXT NOT NULL,
      department_visiting TEXT NOT NULL,
      person_to_visit TEXT NOT NULL,
      in_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      out_time DATETIME,
      security_confirmed BOOLEAN DEFAULT 0,
      security_out_time DATETIME,
      photo_path TEXT,
      email_sent BOOLEAN DEFAULT 0,
      approved BOOLEAN DEFAULT 0,
      qr_code_path TEXT,
      CONSTRAINT chk_contact CHECK (contact_number GLOB '[0-9]*')
    )`);
  });
}

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Email transporter setup with better error handling
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: process.env.EMAIL_PORT || 587,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false // For self-signed certificates
  }
});

// Verify email connection on startup
transporter.verify((error) => {
  if (error) {
    console.error('Email server connection failed:', error);
  } else {
    console.log('Email server is ready to send messages');
  }
});

// Generate QR Code
async function generateQRCode(visitorId) {
  const url = `${process.env.BASE_URL || 'http://localhost:3000'}/api/visitors/${visitorId}/approve`;
  const qrPath = `uploads/qr-${visitorId}.png`;
  
  try {
    await QRCode.toFile(qrPath, url);
    return qrPath;
  } catch (err) {
    console.error('QR Code generation failed:', err);
    return null;
  }
}

// Visitor registration endpoint
app.post('/api/visitors', upload.single('photo'), async (req, res) => {
  try {
    const { full_name, contact_number, department_visiting, person_to_visit } = req.body;
    
    if (!full_name || !contact_number || !department_visiting || !person_to_visit) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    const photoPath = req.file ? req.file.path : null;

    db.run(
      `INSERT INTO visitors (full_name, contact_number, department_visiting, person_to_visit, photo_path) 
       VALUES (?, ?, ?, ?, ?)`,
      [full_name, contact_number, department_visiting, person_to_visit, photoPath],
      async function(err) {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Failed to register visitor' });
        }

        const visitorId = this.lastID;
        const qrPath = await generateQRCode(visitorId);
        
        if (qrPath) {
          db.run('UPDATE visitors SET qr_code_path = ? WHERE id = ?', [qrPath, visitorId]);
        }

        await sendEmails({
          visitorId,
          full_name,
          person_to_visit,
          department_visiting,
          contact_number,
          photoUrl: photoPath ? `${req.protocol}://${req.get('host')}/uploads/${path.basename(photoPath)}` : null,
          qrUrl: qrPath ? `${req.protocol}://${req.get('host')}/${qrPath}` : null
        });

        res.json({
          id: visitorId,
          message: 'Visitor registered successfully'
        });
      }
    );
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Email sending function with improved error handling
async function sendEmails({ visitorId, full_name, person_to_visit, department_visiting, contact_number, photoUrl, qrUrl }) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const approvalUrl = `http://localhost:3000/api/visitors/${visitorId}/approve`;

  const mailOptions = {
    from: `"Visitor System" <${process.env.EMAIL_FROM || 'visitor-system@example.com'}>`,
    subject: `APPROVAL REQUIRED: ${full_name} visiting ${person_to_visit}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Visitor Approval Required</h2>
        <div style="background: #f8f9fa; padding: 20px; border-radius: 8px;">
          <p><strong>Visitor:</strong> ${full_name}</p>
          <p><strong>Contact:</strong> ${contact_number}</p>
          <p><strong>Visiting:</strong> ${department_visiting} (${person_to_visit})</p>
          ${photoUrl ? `<img src="${photoUrl}" alt="Visitor photo" style="max-width: 200px; margin: 10px 0;">` : ''}
        </div>
        
        <div style="margin: 25px 0; text-align: center;">
          <a href="${approvalUrl}" 
             style="background-color: #2ecc71; color: white; padding: 12px 24px; 
                    text-decoration: none; border-radius: 4px; font-weight: bold;">
            APPROVE VISITOR
          </a>
        </div>
        
        <p style="font-size: 12px; color: #7f8c8d;">
          This approval expires in 24 hours. Visitor will auto-checkout if not approved.
        </p>
      </div>
    `
  };

  try {
    // Send to HR
    mailOptions.to = process.env.HR_EMAIL;
    const hrResult = await transporter.sendMail(mailOptions);
    console.log('Email sent to HR:', hrResult.messageId);

    // Send to host
    mailOptions.to = `${person_to_visit.toLowerCase().replace(/\s+/g, '.')}@example.com`;
    const hostResult = await transporter.sendMail(mailOptions);
    console.log('Email sent to host:', hostResult.messageId);

    db.run('UPDATE visitors SET email_sent = 1 WHERE id = ?', [visitorId]);
  } catch (error) {
    console.error('Email sending failed:', error);
    // Retry logic could be added here
  }
}

// Test email endpoint
app.get('/test-email', async (req, res) => {
  try {
    const testEmail = {
      from: `"Visitor System Test" <${process.env.EMAIL_FROM || 'visitor-system@example.com'}>`,
      to: process.env.HR_EMAIL || 'test@example.com',
      subject: 'Visitor System Email Test',
      text: 'This is a test email from your visitor management system',
      html: '<b>Success!</b> Your email system is working correctly.'
    };

    const info = await transporter.sendMail(testEmail);
    res.send(`
      <h1>Email Test Successful</h1>
      <p>Message sent to: ${testEmail.to}</p>
      <p>Message ID: ${info.messageId}</p>
    `);
  } catch (error) {
    console.error('Email test failed:', error);
    res.status(500).send(`
      <h1>Email Test Failed</h1>
      <pre>${error.message}</pre>
      <p>Check your email configuration in .env file</p>
    `);
  }
});

// Approval endpoint
app.get('/api/visitors/:id/approve', (req, res) => {
  const visitorId = req.params.id;
  
  db.run('UPDATE visitors SET approved = 1 WHERE id = ?', [visitorId], function(err) {
    if (err) {
      console.error('Approval error:', err);
      return res.status(500).send('Failed to approve visitor');
    }
    
    if (this.changes === 0) {
      return res.status(404).send('Visitor not found');
    }

    // Get the updated visitor data
    db.get('SELECT * FROM visitors WHERE id = ?', [visitorId], (err, visitor) => {
      if (err || !visitor) {
        return res.status(404).send('Visitor data not found');
      }

      res.send(`
        <!DOCTYPE html>
  <html>
  <head>
    <title>Visitor Approved</title>
    <style>
      body { font-family: Arial, sans-serif; text-align: center; padding: 20px; }
      .btn { 
        padding: 10px 20px; 
        margin: 10px; 
        border: none; 
        color: white; 
        cursor: pointer;
        border-radius: 4px;
      }
      .release-btn { background: #e74c3c; }
    </style>
  </head>
  <body>
    <h1 style="color: #2ecc71;">✓ Visitor Approved</h1>
    <p>${visitor.full_name} is now checked in.</p>
    
    <button class="btn release-btn" 
            onclick="releaseVisitor(${visitorId})">
      Release Visitor
    </button>

    <script>
      function releaseVisitor(id) {
        fetch('/api/visitors/'+id+'/release', {
          method: 'POST'
        })
        .then(response => {
          if (response.ok) {
            alert('Visitor released successfully');
            window.close();
          } else {
            alert('Release failed');
          }
        });
      }
    </script>
  </body>
  </html>
      `);
    });
  });
});



app.post('/api/visitors/:id/release', (req, res) => {
  const visitorId = req.params.id;
  const releaseTime = new Date().toISOString();
  
  db.run(
    `UPDATE visitors SET out_time = ? WHERE id = ?`,
    [releaseTime, visitorId],
    function(err) {
      if (err) {
        console.error('Release error:', err);
        return res.status(500).send('Release failed');
      }
      notifyDashboardUpdate();
      res.sendStatus(200);
    }
  );
});

app.post('/api/visitors/:id/security-checkout', (req, res) => {
  const visitorId = req.params.id;
  const checkoutTime = new Date().toISOString();
  
  db.run(
    `UPDATE visitors SET security_confirmed = 1, security_out_time = ? WHERE id = ?`,
    [checkoutTime, visitorId],
    function(err) {
      if (err) {
        console.error('Security checkout error:', err);
        return res.status(500).send('Checkout failed');
      }
      notifyDashboardUpdate();
      res.sendStatus(200);
    }
  );
});

// Excel export endpoint
app.get('/api/visitors/export', async (req, res) => {
  try {
    const { period } = req.query;
    let query = 'SELECT * FROM visitors';
    const params = [];
    
    // Apply time filters if specified
    if (period === 'day') {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      query += ' WHERE in_time >= ?';
      params.push(startOfDay.toISOString());
    } else if (period === 'week') {
      const startOfWeek = new Date();
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
      query += ' WHERE in_time >= ?';
      params.push(startOfWeek.toISOString());
    } else if (period === 'month') {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      query += ' WHERE in_time >= ?';
      params.push(startOfMonth.toISOString());
    }
    
    query += ' ORDER BY in_time DESC';

    const visitors = await new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Visitors');
    
    // Define columns
    worksheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Full Name', key: 'full_name', width: 25 },
      { header: 'Contact', key: 'contact_number', width: 15 },
      { header: 'Department', key: 'department_visiting', width: 20 },
      { header: 'Host', key: 'person_to_visit', width: 20 },
      { header: 'Check-in', key: 'in_time', width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm:ss' } },
      { header: 'Check-out', key: 'out_time', width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm:ss' } },
      { header: 'Status', key: 'status', width: 15 }
    ];

    // Add data rows
    visitors.forEach(visitor => {
      worksheet.addRow({
        ...visitor,
        status: visitor.out_time 
          ? (visitor.security_confirmed ? 'Completed' : 'Pending Checkout')
          : 'Active'
      });
    });

    // Set response headers
    const filename = `visitors_${period || 'all'}_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    // Send the Excel file
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ 
      error: 'Failed to export data',
      details: error.message
    });
  }
});

// Visitor statistics endpoint
// Visitor statistics endpoint
app.get('/api/visitors/stats', (req, res) => {
  const query = `
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN out_time IS NULL THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN out_time IS NOT NULL AND security_confirmed = 1 THEN 1 ELSE 0 END) as secured,
      SUM(CASE WHEN out_time IS NOT NULL AND security_confirmed = 0 THEN 1 ELSE 0 END) as security_pending
    FROM visitors
  `;
  
  db.get(query, (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Failed to fetch stats' });
    }
    res.json({
      total: row.total || 0,
      active: row.active || 0,
      secured: row.secured || 0,
      security_pending: row.security_pending || 0
    });
  });
});

// Visitor listing endpoint with status filtering
app.get('/api/visitors', (req, res) => {
  const { status } = req.query;
  let query = 'SELECT * FROM visitors';
  const params = [];

  if (status === 'active') {
    query += ' WHERE out_time IS NULL';
  } else if (status === 'released') {
    query += ' WHERE out_time IS NOT NULL AND security_confirmed = 1';
  } else if (status === 'security-pending') {
    query += ' WHERE out_time IS NOT NULL AND security_confirmed = 0';
  }

  query += ' ORDER BY in_time DESC';

  db.all(query, params, (err, visitors) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Failed to fetch visitors' });
    }
    res.json(visitors);
  });
});


// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Handle root route to serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Something went wrong!',
    message: err.message
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`ExcelJS Version: ${require('exceljs').version}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});