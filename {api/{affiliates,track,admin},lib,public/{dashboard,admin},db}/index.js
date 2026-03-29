// index.js (in the root folder)
const express = require('express');
const app = express();
const apiHandler = require('./api/index.js');

// Use JSON middleware which your API likely needs
app.use(express.json());

// Pass all requests to your consolidated API logic
app.all('*', async (req, res) => {
  return await apiHandler(req, res);
});

// For local development
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;