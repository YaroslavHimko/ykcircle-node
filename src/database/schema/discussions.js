export async function initializeDiscussionsSchema(database) {
  await database.execute(`CREATE TABLE IF NOT EXISTS group_forum_threads (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, group_id INT UNSIGNED NOT NULL, author_user_id INT UNSIGNED NOT NULL, title VARCHAR(180) NOT NULL,
        status ENUM('active','locked','removed') NOT NULL DEFAULT 'active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (group_id, status, updated_at), CONSTRAINT group_forum_group_fk FOREIGN KEY (group_id) REFERENCES event_groups(id) ON DELETE CASCADE,
        CONSTRAINT group_forum_author_fk FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS group_forum_messages (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, thread_id INT UNSIGNED NOT NULL, author_user_id INT UNSIGNED NOT NULL, body VARCHAR(4000) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX (thread_id, created_at),
        CONSTRAINT group_forum_message_thread_fk FOREIGN KEY (thread_id) REFERENCES group_forum_threads(id) ON DELETE CASCADE,
        CONSTRAINT group_forum_message_author_fk FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS event_forum_threads (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, event_id INT UNSIGNED NOT NULL, author_user_id INT UNSIGNED NOT NULL, title VARCHAR(180) NOT NULL,
        status ENUM('active','locked','removed') NOT NULL DEFAULT 'active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (event_id, status, updated_at), CONSTRAINT event_forum_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT event_forum_author_fk FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS event_forum_messages (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, thread_id INT UNSIGNED NOT NULL, author_user_id INT UNSIGNED NOT NULL, body VARCHAR(4000) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX (thread_id, created_at),
        CONSTRAINT event_forum_message_thread_fk FOREIGN KEY (thread_id) REFERENCES event_forum_threads(id) ON DELETE CASCADE,
        CONSTRAINT event_forum_message_author_fk FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS forum_thread_reads (
        scope ENUM('group','event') NOT NULL, thread_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, last_read_message_id INT UNSIGNED NOT NULL,
        read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (scope, thread_id, user_id), INDEX (user_id, scope, read_at),
        CONSTRAINT forum_thread_read_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
}
