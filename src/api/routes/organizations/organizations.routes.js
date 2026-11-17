export function registerOrganizationsRoutes(
  app,
  { authenticate, requireVerifiedUser, venueSlug, ensureTable, queries, optionalAuthenticate },
) {
  app.post('/api/organizations', authenticate, requireVerifiedUser, async (req, res) => {
    const name = String(req.body.name || '').trim();
    const slug = venueSlug(req.body.slug || name);
    const websiteUrl = String(req.body.websiteUrl || '').trim() || null;
    const contactEmail =
      String(req.body.contactEmail || '')
        .trim()
        .toLowerCase() || null;
    if (
      name.length < 2 ||
      name.length > 160 ||
      !slug ||
      slug.length > 180 ||
      (websiteUrl && !/^https:\/\//i.test(websiteUrl)) ||
      (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))
    )
      return res.status(422).json({ error: 'Organization is invalid.' });
    try {
      await ensureTable();
      const id = await queries.createOrganization(req.user.id, {
        name,
        slug,
        description: String(req.body.description || '').trim() || null,
        websiteUrl,
        phone: String(req.body.phone || '').trim() || null,
        contactEmail,
      });
      return res.status(201).json(await queries.organization(id, req.user.id, req.user.role));
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY')
        return res.status(409).json({ error: 'That organization slug is already in use.' });
      console.error('Organization creation failed:', error.message);
      return res.status(500).json({ error: 'Unable to create organization.' });
    }
  });
  app.get('/api/organizations/:id', optionalAuthenticate, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1)
      return res.status(422).json({ error: 'A valid organization id is required.' });
    try {
      await ensureTable();
      const organization = await queries.organization(
        id,
        req.user?.id ?? null,
        req.user?.role ?? null,
      );
      return organization
        ? res.json(organization)
        : res.status(404).json({ error: 'Organization not found.' });
    } catch (error) {
      console.error('Organization lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load organization.' });
    }
  });
  app.put('/api/organizations/:id', authenticate, requireVerifiedUser, async (req, res) => {
    const id = Number(req.params.id);
    const name = String(req.body.name || '').trim();
    const slug = venueSlug(req.body.slug || name);
    const websiteUrl = String(req.body.websiteUrl || '').trim() || null;
    const contactEmail =
      String(req.body.contactEmail || '')
        .trim()
        .toLowerCase() || null;
    const description = String(req.body.description || '').trim() || null;
    const phone = String(req.body.phone || '').trim() || null;
    if (
      !Number.isInteger(id) ||
      id < 1 ||
      name.length < 2 ||
      name.length > 160 ||
      !slug ||
      slug.length > 180 ||
      (websiteUrl && (websiteUrl.length > 1024 || !/^https:\/\//i.test(websiteUrl))) ||
      (contactEmail &&
        (contactEmail.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))) ||
      (phone && phone.length > 50) ||
      (description && description.length > 5000)
    )
      return res
        .status(422)
        .json({ error: 'Organization is invalid. Check its name, website, and contact details.' });
    try {
      await ensureTable();
      const organization = await queries.updateOrganization(id, req.user.id, req.user.role, {
        name,
        slug,
        description,
        websiteUrl,
        phone,
        contactEmail,
      });
      if (!organization)
        return res.status(403).json({ error: 'Organization management access is required.' });
      return res.json(organization);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY')
        return res.status(409).json({ error: 'That organization URL name is already in use.' });
      console.error('Organization update failed:', error.message);
      return res.status(500).json({ error: 'Unable to update organization.' });
    }
  });
  app.get('/api/my/organizations', authenticate, async (req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.managedOrganizations(req.user.id, req.user.role));
    } catch (error) {
      console.error('Managed organization lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load organizations.' });
    }
  });
  app.put(
    '/api/organizations/:id/members/:userId',
    authenticate,
    requireVerifiedUser,
    async (req, res) => {
      const organizationId = Number(req.params.id);
      const userId = Number(req.params.userId);
      const role = String(req.body.role || '');
      if (
        !Number.isInteger(organizationId) ||
        !Number.isInteger(userId) ||
        !['owner', 'admin', 'manager', 'staff'].includes(role)
      )
        return res
          .status(422)
          .json({ error: 'A valid organization member and role are required.' });
      try {
        await ensureTable();
        if (
          !(await queries.setOrganizationMember(
            organizationId,
            req.user.id,
            req.user.role,
            userId,
            role,
          ))
        )
          return res.status(403).json({ error: 'Organization owner or admin access is required.' });
        return res.json({ organizationId, userId, role });
      } catch (error) {
        console.error('Organization member update failed:', error.message);
        return res.status(500).json({ error: 'Unable to update organization member.' });
      }
    },
  );
}
