export function createGroupsValidation({ ensureTable, queries }) {
  const groupInput = (body) => ({
    name: String(body.name || '').trim(),
    description: body.description == null ? null : String(body.description).trim() || null,
    visibility: body.visibility || 'Public',
  });
  const validateGroup = (group) => {
    const fields = {};
    if (group.name.length < 3 || group.name.length > 120)
      fields.name = 'Name must be between 3 and 120 characters.';
    if (group.description?.length > 10000)
      fields.description = 'Description must not exceed 10,000 characters.';
    if (!['Public', 'Private'].includes(group.visibility))
      fields.visibility = 'Visibility must be Public or Private.';
    return fields;
  };
  const groupSlug = (value) =>
    String(value)
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const requireManagedGroup = async (req, res, next) => {
    try {
      await ensureTable();
      if (!(await queries.groupExists(req.params.id)))
        return res.status(404).json({ error: 'Group not found.' });
      if (!(await queries.canManageGroup(req.params.id, req.user.id, req.user.role)))
        return res.status(403).json({ error: 'You do not manage this group.' });
      req.managedGroup = await queries.group(req.params.id, req.user.id, req.user.role);
      return next();
    } catch (error) {
      return res.status(500).json({ error: 'Unable to validate group access.' });
    }
  };
  return { groupInput, validateGroup, groupSlug, requireManagedGroup };
}
