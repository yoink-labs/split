-- Normalize member and account display names, including historical labels.
-- The character list matches JavaScript whitespace. IDs and references stay intact.

WITH RECURSIVE
  whitespace(chars) AS (VALUES(char(9,10,11,12,13,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))),
  spaces(i, ch) AS (
    SELECT 1, substr(chars,1,1) FROM whitespace
    UNION ALL
    SELECT i+1, substr(chars,i+1,1) FROM spaces, whitespace WHERE i<length(chars)
  ),
  names(id, value, i) AS (
    SELECT id, name, 1 FROM members
    WHERE EXISTS (SELECT 1 FROM spaces WHERE instr(name, ch)>0)
      OR name LIKE ' %' OR name LIKE '% ' OR name LIKE '%  %'
    UNION ALL
    SELECT id, replace(value, substr(chars,i,1), ' '), i+1 FROM names, whitespace
    WHERE i<=length(chars)
  ),
  collapsed(id, value) AS (
    SELECT id, trim(value) FROM names, whitespace WHERE i=length(chars)+1
    UNION ALL
    SELECT id, replace(value, '  ', ' ') FROM collapsed WHERE instr(value, '  ')>0
  )
UPDATE members SET name=collapsed.value FROM collapsed
WHERE members.id=collapsed.id AND instr(collapsed.value, '  ')=0;

WITH RECURSIVE
  whitespace(chars) AS (VALUES(char(9,10,11,12,13,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))),
  spaces(i, ch) AS (
    SELECT 1, substr(chars,1,1) FROM whitespace
    UNION ALL
    SELECT i+1, substr(chars,i+1,1) FROM spaces, whitespace WHERE i<length(chars)
  ),
  names(id, value, i) AS (
    SELECT user_id, name, 1 FROM split_profiles
    WHERE EXISTS (SELECT 1 FROM spaces WHERE instr(name, ch)>0)
      OR name LIKE ' %' OR name LIKE '% ' OR name LIKE '%  %'
    UNION ALL
    SELECT id, replace(value, substr(chars,i,1), ' '), i+1 FROM names, whitespace
    WHERE i<=length(chars)
  ),
  collapsed(id, value) AS (
    SELECT id, trim(value) FROM names, whitespace WHERE i=length(chars)+1
    UNION ALL
    SELECT id, replace(value, '  ', ' ') FROM collapsed WHERE instr(value, '  ')>0
  )
UPDATE split_profiles SET name=collapsed.value FROM collapsed
WHERE split_profiles.user_id=collapsed.id AND instr(collapsed.value, '  ')=0;

WITH RECURSIVE
  whitespace(chars) AS (VALUES(char(9,10,11,12,13,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))),
  spaces(i, ch) AS (
    SELECT 1, substr(chars,1,1) FROM whitespace
    UNION ALL
    SELECT i+1, substr(chars,i+1,1) FROM spaces, whitespace WHERE i<length(chars)
  ),
  names(id, value, i) AS (
    SELECT id, member_name, 1 FROM member_links
    WHERE EXISTS (SELECT 1 FROM spaces WHERE instr(member_name, ch)>0)
      OR member_name LIKE ' %' OR member_name LIKE '% ' OR member_name LIKE '%  %'
    UNION ALL
    SELECT id, replace(value, substr(chars,i,1), ' '), i+1 FROM names, whitespace
    WHERE i<=length(chars)
  ),
  collapsed(id, value) AS (
    SELECT id, trim(value) FROM names, whitespace WHERE i=length(chars)+1
    UNION ALL
    SELECT id, replace(value, '  ', ' ') FROM collapsed WHERE instr(value, '  ')>0
  )
UPDATE member_links SET member_name=collapsed.value FROM collapsed
WHERE member_links.id=collapsed.id AND instr(collapsed.value, '  ')=0;

WITH RECURSIVE
  whitespace(chars) AS (VALUES(char(9,10,11,12,13,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))),
  spaces(i, ch) AS (
    SELECT 1, substr(chars,1,1) FROM whitespace
    UNION ALL
    SELECT i+1, substr(chars,i+1,1) FROM spaces, whitespace WHERE i<length(chars)
  ),
  names(id, value, i) AS (
    SELECT id, author_name, 1 FROM entry_comments
    WHERE EXISTS (SELECT 1 FROM spaces WHERE instr(author_name, ch)>0)
      OR author_name LIKE ' %' OR author_name LIKE '% ' OR author_name LIKE '%  %'
    UNION ALL
    SELECT id, replace(value, substr(chars,i,1), ' '), i+1 FROM names, whitespace
    WHERE i<=length(chars)
  ),
  collapsed(id, value) AS (
    SELECT id, trim(value) FROM names, whitespace WHERE i=length(chars)+1
    UNION ALL
    SELECT id, replace(value, '  ', ' ') FROM collapsed WHERE instr(value, '  ')>0
  )
UPDATE entry_comments SET author_name=collapsed.value FROM collapsed
WHERE entry_comments.id=collapsed.id AND instr(collapsed.value, '  ')=0;
