ALTER TABLE lists ADD COLUMN private_token_policy TEXT NOT NULL DEFAULT 'always';
ALTER TABLE lists ADD COLUMN raw_token_ciphertext TEXT;

UPDATE lists
SET private_token_policy = 'one_time'
WHERE visibility = 'private';
