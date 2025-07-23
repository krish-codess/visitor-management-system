const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data/visitors.db');

// Delete all visitors
db.run('DELETE FROM visitors', (err) => {
  if (err) {
    console.error('Error deleting entries:', err);
  } else {
    console.log('All visitor entries deleted successfully');
  }
  db.close();
});

// Optional: Reset auto-increment counter
db.run('DELETE FROM sqlite_sequence WHERE name="visitors"');