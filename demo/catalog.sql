CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subtitle TEXT NOT NULL,
  price REAL NOT NULL,
  rating REAL NOT NULL,
  finish TEXT NOT NULL
);
CREATE TABLE cart_items (
  product_id TEXT PRIMARY KEY REFERENCES products(id),
  quantity INTEGER NOT NULL DEFAULT 1
);
INSERT INTO products VALUES
  ('orbit', 'Orbit table light', 'A softer kind of evening.', 129, 4.9, 'Sandstone'),
  ('arc', 'Arc desk light', 'Light for a little focus.', 89, 4.8, 'Graphite'),
  ('halo', 'Halo pendant', 'Room for a brighter idea.', 179, 4.7, 'Chalk');
