// IndexedDB schema for whoof.
// Mirrors the SQLite schema in whoof/db.py:15-110 so the Python rollups
// can serve as a porting reference.

export const DB_NAME = 'whoof';
export const DB_VERSION = 4;

// indexes: [indexName, keyPath?] — keyPath defaults to indexName
export const STORES = {
  samples: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [
      ['ts_utc'],
      ['session_id'],
      ['session_sequence', ['session_id', 'sequence']],
    ],
  },
  sessions: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [['started_at']],
  },
  device_events: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [['ts_utc']],
  },
  daily_metrics: {
    keyPath: 'date',
    indexes: [],
  },
  profile: {
    keyPath: 'id',
    indexes: [],
  },
  sleep_stages: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [['date'], ['start_utc']],
  },
  workouts: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [['date']],
  },
  food_entries: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [['date'], ['meal']],
  },
  body_weight_entries: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [['date'], ['source']],
  },
  captures: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [['created_at'], ['label']],
  },
  // Activity journal: user-authored annotations for each day.
  // tags: string[] — common tags like 'alcohol','illness','stress','travel','race'
  journal: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [['date']],
  },
};
