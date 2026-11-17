import mysql from 'mysql2/promise';
import { initializeSchema } from './schema/index.js';
export class Database {
  constructor(config) {
    this.pool = mysql.createPool({
      ...config,
      timezone: 'Z',
      waitForConnections: true,
      connectionLimit: 5,
    });
    this.initialized = null;
  }
  initialize() {
    this.initialized ||= initializeSchema(this.pool);
    return this.initialized;
  }
  execute(...args) {
    return this.pool.execute(...args);
  }
  query(...args) {
    return this.pool.query(...args);
  }
  getConnection() {
    return this.pool.getConnection();
  }
  close() {
    return this.pool.end();
  }
}
