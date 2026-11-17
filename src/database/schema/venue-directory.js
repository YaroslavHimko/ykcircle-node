export async function initializeVenueDirectorySchema(database) {
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_types (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(100) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL, sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE
      )`);
  await database.execute(`INSERT IGNORE INTO venue_types (slug, name, sort_order) VALUES
        ('event-space','Event space',10),('conference-room','Conference room',20),('meeting-room','Meeting room',30),('restaurant','Restaurant',40),('bar','Bar',50),('cafe','Café',60),('rooftop','Rooftop',70),('studio','Studio',80),('photography-studio','Photography studio',90),('music-rehearsal-studio','Music rehearsal studio',100),('dance-studio','Dance studio',110),('sports-facility','Sports facility',120),('tennis-court','Tennis court',130),('padel-court','Padel court',140),('coworking-space','Coworking space',150),('classroom','Classroom',160),('gallery','Gallery',170),('theatre','Theatre',180),('cinema','Cinema',190),('outdoor-venue','Outdoor venue',200),('park','Park',210),('community-center','Community center',220),('private-dining-room','Private dining room',230),('party-venue','Party venue',240),('wedding-venue','Wedding venue',250),('hotel-venue','Hotel venue',260),('other','Other',999)`);
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_event_types (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(100) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL, sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE
      )`);
  await database.execute(`INSERT IGNORE INTO venue_event_types (slug, name, sort_order) VALUES
        ('meetup','Meetup',10),('workshop','Workshop',20),('class','Class',30),('networking','Networking',40),('conference','Conference',50),('party','Party',60),('private-dinner','Private dinner',70),('birthday','Birthday',80),('wedding','Wedding',90),('concert','Concert',100),('rehearsal','Rehearsal',110),('photography','Photography',120),('video-production','Video production',130),('yoga','Yoga',140),('sports','Sports',150),('exhibition','Exhibition',160),('product-launch','Product launch',170),('corporate-event','Corporate event',180),('community-event','Community event',190)`);
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_amenities (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(100) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL, category VARCHAR(80) NOT NULL, sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE
      )`);
  await database.execute(`INSERT IGNORE INTO venue_amenities (slug, name, category, sort_order) VALUES
        ('wifi','Wi-Fi','technology',10),('projector','Projector','technology',20),('tv-display','TV / display','technology',30),('microphones','Microphones','technology',40),('pa-system','PA system','technology',50),('speakers','Speakers','technology',60),('stage-lighting','Stage lighting','technology',70),('streaming-equipment','Streaming equipment','technology',80),('tables','Tables','furniture',10),('chairs','Chairs','furniture',20),('sofas','Sofas','furniture',30),('standing-tables','Standing tables','furniture',40),('podium','Podium','furniture',50),('kitchen','Kitchen','food',10),('catering-allowed','Catering allowed','food',20),('external-catering-allowed','External catering allowed','food',30),('bar','Bar','food',40),('refrigerator','Refrigerator','food',50),('coffee-machine','Coffee machine','food',60),('step-free-entrance','Step-free entrance','accessibility',10),('accessible-toilet','Accessible toilet','accessibility',20),('elevator','Elevator','accessibility',30),('accessible-parking','Accessible parking','accessibility',40),('toilets','Toilets','facilities',10),('changing-rooms','Changing rooms','facilities',20),('shower','Shower','facilities',30),('coat-storage','Coat storage','facilities',40),('reception','Reception','facilities',50),('storage-room','Storage room','facilities',60),('parking','Parking','transport',10),('bicycle-parking','Bicycle parking','transport',20),('near-metro','Near metro','transport',30),('near-train','Near train','transport',40),('near-bus','Near bus','transport',50)`);
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_amenity_assignments (
        venue_id INT UNSIGNED NOT NULL, amenity_id INT UNSIGNED NOT NULL, PRIMARY KEY (venue_id, amenity_id), INDEX venue_amenity_assignments_amenity (amenity_id, venue_id),
        CONSTRAINT venue_amenity_assignments_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE, CONSTRAINT venue_amenity_assignments_amenity_fk FOREIGN KEY (amenity_id) REFERENCES venue_amenities(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_event_type_assignments (
        venue_id INT UNSIGNED NOT NULL, event_type_id INT UNSIGNED NOT NULL, PRIMARY KEY (venue_id, event_type_id), INDEX venue_event_type_assignments_type (event_type_id, venue_id),
        CONSTRAINT venue_event_type_assignments_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE, CONSTRAINT venue_event_type_assignments_type_fk FOREIGN KEY (event_type_id) REFERENCES venue_event_types(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_inquiries (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, venue_id INT UNSIGNED NOT NULL, organizer_user_id INT UNSIGNED NOT NULL, event_id INT UNSIGNED NULL,
        event_name VARCHAR(200) NOT NULL, event_type VARCHAR(120) NULL, requested_date DATE NULL, start_time TIME NULL, end_time TIME NULL, expected_guests INT UNSIGNED NULL, budget DECIMAL(10,2) NULL, message TEXT NOT NULL,
        status ENUM('new','viewed','responded','accepted','declined','cancelled') NOT NULL DEFAULT 'new', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX venue_inquiries_venue_status (venue_id, status, created_at), INDEX venue_inquiries_organizer (organizer_user_id, created_at),
        CONSTRAINT venue_inquiries_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE, CONSTRAINT venue_inquiries_organizer_fk FOREIGN KEY (organizer_user_id) REFERENCES users(id) ON DELETE CASCADE, CONSTRAINT venue_inquiries_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS saved_venues (
        user_id INT UNSIGNED NOT NULL, venue_id INT UNSIGNED NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, venue_id), INDEX saved_venues_venue (venue_id),
        CONSTRAINT saved_venues_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, CONSTRAINT saved_venues_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_promotions (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, venue_id INT UNSIGNED NOT NULL, promotion_type ENUM('featured_search','featured_city','homepage_feature','category_feature') NOT NULL, city VARCHAR(120) NULL, venue_type_id INT UNSIGNED NULL,
        starts_at DATETIME NOT NULL, ends_at DATETIME NOT NULL, status ENUM('draft','scheduled','active','paused','ended') NOT NULL DEFAULT 'draft', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX venue_promotions_active (status, starts_at, ends_at), CONSTRAINT venue_promotions_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
      )`);
}
