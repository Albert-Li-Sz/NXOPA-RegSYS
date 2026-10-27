-- Existing version-mismatched PDFs are already unavailable to their owners.
-- Mark them stale explicitly; never revive them because their content may have
-- changed for reasons other than finance. Administrators can regenerate them.
UPDATE "AdmissionDocument" document
SET state = 'STALE', "releasedAt" = NULL, version = document.version + 1
FROM "Registration" registration
WHERE document."registrationId" = registration.id
  AND document.state IN ('READY', 'RELEASED')
  AND document."registrationVersion" <> registration.version;
