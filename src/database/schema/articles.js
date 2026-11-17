export async function initializeArticlesSchema(database) {
  await database.execute(`CREATE TABLE IF NOT EXISTS article_categories (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, slug VARCHAR(120) NOT NULL UNIQUE,
        description VARCHAR(255) NULL, sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
  await database.execute(`INSERT IGNORE INTO article_categories (name, slug, sort_order) VALUES
        ('News', 'news', 10), ('Guides', 'guides', 20), ('Community Stories', 'community-stories', 30), ('Updates', 'updates', 40)`);
  await database.execute(`CREATE TABLE IF NOT EXISTS articles (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(180) NOT NULL UNIQUE, author_user_id INT UNSIGNED NOT NULL,
        category_id INT UNSIGNED NULL, title VARCHAR(200) NOT NULL, excerpt VARCHAR(400) NOT NULL, body MEDIUMTEXT NOT NULL,
        cover_image VARCHAR(255) NULL, cover_alt_text VARCHAR(200) NULL,
        status ENUM('draft','published','archived','removed') NOT NULL DEFAULT 'draft', is_indexable BOOLEAN NOT NULL DEFAULT TRUE,
        published_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX article_public_index (status, is_indexable, published_at), INDEX (author_user_id), INDEX (category_id),
        CONSTRAINT article_author_fk FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT article_category_fk FOREIGN KEY (category_id) REFERENCES article_categories(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS article_publications (
        article_id INT UNSIGNED PRIMARY KEY, user_id INT UNSIGNED NOT NULL, published_at DATETIME NOT NULL,
        INDEX article_publications_user_month (user_id, published_at),
        CONSTRAINT article_publications_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS article_tags (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80) NOT NULL, slug VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS article_tag_assignments (
        article_id INT UNSIGNED NOT NULL, tag_id INT UNSIGNED NOT NULL,
        PRIMARY KEY (article_id, tag_id), INDEX (tag_id),
        CONSTRAINT article_tag_article_fk FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
        CONSTRAINT article_tag_tag_fk FOREIGN KEY (tag_id) REFERENCES article_tags(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS article_media (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, article_id INT UNSIGNED NOT NULL, filename VARCHAR(255) NOT NULL UNIQUE,
        alt_text VARCHAR(200) NOT NULL, caption VARCHAR(500) NULL, sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX (article_id, sort_order),
        CONSTRAINT article_media_article_fk FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
      )`);
}
