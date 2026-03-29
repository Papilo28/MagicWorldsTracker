// index.js (In the ROOT folder)
const express = require('express');
const app = express();
const apiHandler = require('./api/index.js');

// Standard middleware for processing data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Forward ALL requests to your consolidated /api/index.js logic
app.all('*', async (req, res) => {
  try {
    return await apiHandler(req, res);
  } catch (error) {
    console.error('Bridge Error:', error);
    res.status(500).json({ error: 'Bridge routing failed', message: error.message });
  }
});

// For local development only
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Development server: http://localhost:${PORT}`);
  });
}

module.exports = app;