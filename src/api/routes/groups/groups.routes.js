import crypto from 'node:crypto';

export function registerGroupsRoutes(
  app,
  {
    optionalAuthenticate,
    ensureTable,
    decorateGroups,
    queries,
    authenticate,
    groupInput,
    validateGroup,
    groupSlug,
    decorateGroup,
    requireManagedGroup,
    emailService,
    parseGroupCover,
    groupFtpService,
  },
) {
  app.get('/api/groups', optionalAuthenticate, async (req, res) => {
    try {
      await ensureTable();
      const viewer = { userId: req.user?.id ?? null, role: req.user?.role ?? null };
      return res.json(
        decorateGroups(await queries.groupsForViewer(viewer.userId, viewer.role), viewer),
      );
    } catch (error) {
      console.error('Group lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load groups.' });
    }
  });
  app.get('/api/my/groups', authenticate, async (req, res) => {
    try {
      await ensureTable();
      const viewer = { userId: req.user.id, role: req.user.role };
      return res.json(
        decorateGroups(
          await queries.groupsForViewer(viewer.userId, viewer.role, { membershipOnly: true }),
          viewer,
        ),
      );
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load your groups.' });
    }
  });
  app.get('/api/my/groups/managed', authenticate, async (req, res) => {
    try {
      await ensureTable();
      const viewer = { userId: req.user.id, role: req.user.role };
      return res.json(
        decorateGroups(
          await queries.groupsForViewer(viewer.userId, viewer.role, { managedOnly: true }),
          viewer,
        ),
      );
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load managed groups.' });
    }
  });
  app.post('/api/groups', authenticate, async (req, res) => {
    if (!req.user.isEmailConfirmed)
      return res.status(403).json({
        code: 'EMAIL_NOT_VERIFIED',
        error: 'Please verify your email address before creating a group.',
      });
    const group = groupInput(req.body);
    const fields = validateGroup(group);
    if (Object.keys(fields).length)
      return res.status(422).json({ error: 'Group is invalid.', fields });
    const slug = groupSlug(req.body.slug || group.name);
    if (!slug || slug.length > 140)
      return res.status(422).json({
        error: 'Group is invalid.',
        fields: { slug: 'Provide a valid slug up to 140 characters.' },
      });
    try {
      await ensureTable();
      const id = await queries.createGroup({ organizerId: req.user.id, ...group, slug });
      return res.status(201).json(
        decorateGroup(await queries.group(id, req.user.id, req.user.role), {
          userId: req.user.id,
          role: req.user.role,
        }),
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY')
        return res.status(409).json({ error: 'A group with this name or slug already exists.' });
      console.error('Group creation failed:', error.message);
      return res.status(500).json({ error: 'Unable to create group.' });
    }
  });
  app.post('/api/group-invitations/respond', async (req, res) => {
    const token = String(req.body.token || '');
    const action = String(req.body.action || '');
    if (!token || !['accept', 'decline'].includes(action))
      return res.status(422).json({ error: 'A valid invitation token and action are required.' });
    try {
      await ensureTable();
      const result = await queries.respondToGroupInvitation(token, action);
      if (result.error === 'INVALID')
        return res
          .status(400)
          .json({ error: 'This group invitation is invalid, expired, or has already been used.' });
      if (result.error === 'ACCOUNT_REQUIRED')
        return res.status(409).json({
          code: 'ACCOUNT_REQUIRED',
          error:
            'Create an account with the invited email address before accepting this invitation.',
          email: result.email,
        });
      if (result.error === 'EMAIL_NOT_VERIFIED')
        return res.status(403).json({
          code: 'EMAIL_NOT_VERIFIED',
          error: 'Verify the invited email address before accepting this invitation.',
        });
      return res.json({
        message: result.status === 'accepted' ? 'You joined the group.' : 'Invitation declined.',
        status: result.status,
        groupId: result.groupId,
        groupName: result.groupName,
      });
    } catch (error) {
      console.error('Group invitation response failed:', error.message);
      return res.status(500).json({ error: 'Unable to respond to this group invitation.' });
    }
  });
  app.post('/api/groups/:id/invitations', authenticate, requireManagedGroup, async (req, res) => {
    if (Number(req.managedGroup.organizerId) !== req.user.id)
      return res.status(403).json({ error: 'Only the group organizer can invite members.' });
    const rawUserId = req.body.userId;
    const email = String(req.body.email || '').trim();
    const hasUserId = rawUserId !== undefined && rawUserId !== null && rawUserId !== '';
    const hasEmail = Boolean(email);
    if (hasUserId === hasEmail)
      return res.status(422).json({
        error: 'Invitation is invalid.',
        fields: { invitee: 'Provide exactly one of userId or email.' },
      });
    const userId = hasUserId ? Number(rawUserId) : null;
    if (hasUserId && (!Number.isInteger(userId) || userId < 1))
      return res.status(422).json({
        error: 'Invitation is invalid.',
        fields: { userId: 'userId must be a positive integer.' },
      });
    if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(422).json({
        error: 'Invitation is invalid.',
        fields: { email: 'Provide a valid email address.' },
      });
    try {
      const token = crypto.randomBytes(32).toString('base64url');
      const result = await queries.createGroupInvitation(
        Number(req.params.id),
        req.user.id,
        { userId, email },
        crypto.createHash('sha256').update(token).digest('hex'),
      );
      if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Group not found.' });
      if (result.error === 'NOT_PRIVATE')
        return res.status(409).json({
          error: 'Only private groups use invitations; users can join public groups directly.',
        });
      if (result.error === 'ALREADY_MEMBER')
        return res.status(409).json({ error: 'This user is already an active group member.' });
      if (result.error === 'USER_NOT_FOUND')
        return res
          .status(404)
          .json({ error: 'No user or valid email was found for this invitation.' });
      await emailService.sendGroupInvitation(
        result.recipient.email,
        result.recipient.name,
        result.group,
        token,
      );
      return res
        .status(201)
        .json({ message: 'Group invitation sent.', invitation: result.invitation });
    } catch (error) {
      console.error('Group invitation failed:', error.message);
      return res.status(502).json({ error: 'Unable to send group invitation.' });
    }
  });
  app.get('/api/groups/:id/invitations', authenticate, requireManagedGroup, async (req, res) => {
    if (Number(req.managedGroup.organizerId) !== req.user.id)
      return res.status(403).json({ error: 'Only the group organizer can view invitations.' });
    try {
      return res.json(await queries.groupInvitations(Number(req.params.id)));
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load group invitations.' });
    }
  });
  app.post(
    '/api/groups/:id/cover',
    authenticate,
    requireManagedGroup,
    parseGroupCover,
    async (req, res) => {
      if (!req.file)
        return res.status(422).json({
          error: 'Group cover is invalid.',
          fields: { coverImage: 'A JPEG, PNG, or WebP image is required.' },
        });
      let coverImage;
      let coverPersisted = false;
      try {
        coverImage = await groupFtpService.uploadGroupCover(req.params.id, req.file);
        if (!(await queries.setGroupCover(req.params.id, req.user.id, req.user.role, coverImage))) {
          await groupFtpService.deleteGroupCover(coverImage);
          return res.status(404).json({ error: 'Group not found or not managed by you.' });
        }
        coverPersisted = true;
        const group = await queries.group(req.params.id, req.user.id, req.user.role);
        if (req.managedGroup.coverImage) {
          try {
            await groupFtpService.deleteGroupCover(req.managedGroup.coverImage);
          } catch (cleanupError) {
            console.error('Previous group cover cleanup failed:', cleanupError.message);
          }
        }
        return res.json(decorateGroup(group, { userId: req.user.id, role: req.user.role }));
      } catch (error) {
        if (coverImage && !coverPersisted) {
          try {
            await groupFtpService.deleteGroupCover(coverImage);
          } catch (cleanupError) {
            console.error('New group cover cleanup failed:', cleanupError.message);
          }
        }
        if (error.code === 'INVALID_IMAGE')
          return res
            .status(422)
            .json({ error: 'Group cover is invalid.', fields: { coverImage: error.message } });
        if (error.code === 'FTP_NOT_CONFIGURED')
          return res.status(503).json({ error: 'Group image storage is not configured.' });
        console.error('Group cover upload failed:', error.message);
        return res.status(502).json({ error: 'Unable to upload group cover.' });
      }
    },
  );
  app.get('/api/groups/:id', optionalAuthenticate, async (req, res) => {
    try {
      await ensureTable();
      const group = await queries.group(
        req.params.id,
        req.user?.id ?? null,
        req.user?.role ?? null,
      );
      if (!group) return res.status(404).json({ error: 'Group not found.' });
      group.events = await queries.groupEvents(
        group.id,
        req.user?.id ?? null,
        req.user?.role ?? null,
      );
      return res.json(
        decorateGroup(group, { userId: req.user?.id ?? null, role: req.user?.role ?? null }),
      );
    } catch (error) {
      console.error('Group detail lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load group.' });
    }
  });
  app.get('/api/groups/:id/threads', authenticate, async (req, res) => {
    const groupId = Number(req.params.id);
    if (!Number.isInteger(groupId) || groupId < 1)
      return res.status(404).json({ error: 'Group not found.' });
    try {
      await ensureTable();
      if (!(await queries.groupForumAccess(groupId, req.user.id, req.user.role)))
        return res.status(404).json({ error: 'Group not found or you are not a member.' });
      return res.json(await queries.forumThreads('group', groupId, req.user.id));
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load group threads.' });
    }
  });
  app.post('/api/groups/:id/threads', authenticate, async (req, res) => {
    const groupId = Number(req.params.id);
    const title = String(req.body.title || '').trim();
    const body = String(req.body.body || '').trim();
    if (!req.user.isEmailConfirmed)
      return res
        .status(403)
        .json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before posting.' });
    if (
      !Number.isInteger(groupId) ||
      groupId < 1 ||
      title.length < 3 ||
      title.length > 180 ||
      !body ||
      body.length > 4000
    )
      return res.status(422).json({
        error: 'Thread title must be 3–180 characters and body must be 1–4,000 characters.',
      });
    try {
      await ensureTable();
      if (!(await queries.groupForumAccess(groupId, req.user.id, req.user.role)))
        return res.status(404).json({ error: 'Group not found or you are not a member.' });
      const id = await queries.createForumThread('group', groupId, req.user.id, title, body);
      return res.status(201).json({ id, groupId, title, status: 'active' });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to create group thread.' });
    }
  });
  app.get('/api/groups/:groupId/threads/:threadId/messages', authenticate, async (req, res) => {
    const groupId = Number(req.params.groupId);
    const threadId = Number(req.params.threadId);
    if (!Number.isInteger(groupId) || !Number.isInteger(threadId))
      return res.status(404).json({ error: 'Group thread not found.' });
    try {
      await ensureTable();
      if (
        !(await queries.groupForumAccess(groupId, req.user.id, req.user.role)) ||
        !(await queries.forumThread('group', groupId, threadId))
      )
        return res.status(404).json({ error: 'Group thread not found.' });
      const messages = await queries.forumMessages('group', threadId);
      await queries.markForumThreadRead('group', threadId, req.user.id, messages.at(-1)?.id);
      return res.json(messages);
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load thread messages.' });
    }
  });
  app.post('/api/groups/:groupId/threads/:threadId/messages', authenticate, async (req, res) => {
    const groupId = Number(req.params.groupId);
    const threadId = Number(req.params.threadId);
    const body = String(req.body.body || '').trim();
    if (!req.user.isEmailConfirmed)
      return res
        .status(403)
        .json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before posting.' });
    if (!Number.isInteger(groupId) || !Number.isInteger(threadId) || !body || body.length > 4000)
      return res.status(422).json({ error: 'Message must be between 1 and 4,000 characters.' });
    try {
      await ensureTable();
      if (!(await queries.groupForumAccess(groupId, req.user.id, req.user.role)))
        return res.status(404).json({ error: 'Group not found or you are not a member.' });
      const thread = await queries.forumThread('group', groupId, threadId);
      if (!thread) return res.status(404).json({ error: 'Group thread not found.' });
      if (thread.status !== 'active')
        return res.status(409).json({ error: 'This group thread is locked.' });
      const id = await queries.addForumMessage('group', threadId, req.user.id, body);
      return res.status(201).json({ id, threadId, body });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to send thread message.' });
    }
  });
  app.patch('/api/groups/:groupId/threads/:threadId', authenticate, async (req, res) => {
    const groupId = Number(req.params.groupId);
    const threadId = Number(req.params.threadId);
    const status = String(req.body.status || '');
    if (
      !Number.isInteger(groupId) ||
      !Number.isInteger(threadId) ||
      !['active', 'locked', 'removed'].includes(status)
    )
      return res.status(422).json({ error: 'Invalid thread status.' });
    try {
      await ensureTable();
      if (
        !(await queries.canManageGroup(groupId, req.user.id, req.user.role)) ||
        !(await queries.forumThread('group', groupId, threadId))
      )
        return res.status(404).json({ error: 'Group thread not found or not managed by you.' });
      await queries.setForumThreadStatus('group', threadId, status);
      return res.json({ id: threadId, status });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to moderate group thread.' });
    }
  });
  app.patch('/api/groups/:id', authenticate, requireManagedGroup, async (req, res) => {
    const group = groupInput(req.body);
    const fields = validateGroup(group);
    if (Object.keys(fields).length)
      return res.status(422).json({ error: 'Group is invalid.', fields });
    try {
      await ensureTable();
      if (!(await queries.updateGroup(req.params.id, req.user.id, req.user.role, group)))
        return res.status(404).json({ error: 'Group not found or not managed by you.' });
      return res.json(
        decorateGroup(await queries.group(req.params.id, req.user.id, req.user.role), {
          userId: req.user.id,
          role: req.user.role,
        }),
      );
    } catch (error) {
      return res.status(500).json({ error: 'Unable to update group.' });
    }
  });
  app.delete('/api/groups/:id', authenticate, requireManagedGroup, async (req, res) => {
    try {
      await ensureTable();
      if (!(await queries.deleteGroup(req.params.id, req.user.id, req.user.role)))
        return res.status(404).json({ error: 'Group not found or not managed by you.' });
      return res.json({ message: 'Group deleted.' });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to delete group.' });
    }
  });
  app.post('/api/groups/:id/join', authenticate, async (req, res) => {
    if (!req.user.isEmailConfirmed)
      return res.status(403).json({
        code: 'EMAIL_NOT_VERIFIED',
        error: 'Please verify your email address before joining a group.',
      });
    try {
      await ensureTable();
      const result = await queries.joinGroup(req.params.id, req.user.id);
      if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Group not found.' });
      if (result.error === 'PRIVATE')
        return res.status(403).json({ error: 'This private group cannot be joined directly.' });
      return res.status(result.joined ? 201 : 200).json({
        message: result.joined ? 'You joined the group.' : 'You are already a member.',
        isMember: true,
      });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to join group.' });
    }
  });
  app.delete('/api/groups/:id/membership', authenticate, async (req, res) => {
    try {
      await ensureTable();
      if (!(await queries.leaveGroup(req.params.id, req.user.id)))
        return res.status(409).json({ error: 'You are not a member, or you own this group.' });
      return res.json({ message: 'You left the group.', isMember: false });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to leave group.' });
    }
  });
  app.get('/api/groups/:id/members', authenticate, async (req, res) => {
    try {
      await ensureTable();
      if (!(await queries.canManageGroup(req.params.id, req.user.id, req.user.role)))
        return res.status(404).json({ error: 'Group not found or not managed by you.' });
      return res.json(await queries.groupMembers(req.params.id, req.user.id, req.user.role));
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load group members.' });
    }
  });
  app.post('/api/groups/:id/members', authenticate, requireManagedGroup, async (req, res) => {
    const rawUserId = req.body.userId;
    const email = String(req.body.email || '').trim();
    const hasUserId = rawUserId !== undefined && rawUserId !== null && rawUserId !== '';
    const hasEmail = Boolean(email);
    if (hasUserId === hasEmail)
      return res.status(422).json({
        error: 'Member is invalid.',
        fields: { member: 'Provide exactly one of userId or email.' },
      });
    const userId = hasUserId ? Number(rawUserId) : null;
    if (hasUserId && (!Number.isInteger(userId) || userId < 1))
      return res.status(422).json({
        error: 'Member is invalid.',
        fields: { userId: 'userId must be a positive integer.' },
      });
    if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res
        .status(422)
        .json({ error: 'Member is invalid.', fields: { email: 'Provide a valid email address.' } });
    try {
      const result = await queries.addGroupMember(req.params.id, { userId, email });
      if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Group not found.' });
      if (result.error === 'PRIVATE')
        return res.status(409).json({
          error: 'Invite private-group members through POST /api/groups/:id/invitations.',
        });
      if (result.error === 'USER_NOT_FOUND')
        return res.status(404).json({ error: 'No registered user matches this member.' });
      if (result.error === 'EMAIL_NOT_VERIFIED')
        return res.status(409).json({
          code: 'EMAIL_NOT_VERIFIED',
          error: 'This user must verify their email before joining a group.',
        });
      return res.status(result.added ? 201 : 200).json({
        message: result.added ? 'Member added.' : 'This user is already a member.',
        member: result.member,
      });
    } catch (error) {
      console.error('Group member addition failed:', error.message);
      return res.status(500).json({ error: 'Unable to add group member.' });
    }
  });
  app.delete(
    '/api/groups/:id/members/:userId',
    authenticate,
    requireManagedGroup,
    async (req, res) => {
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId) || userId < 1)
        return res.status(404).json({ error: 'Member not found.' });
      try {
        const result = await queries.removeGroupMember(req.params.id, userId);
        if (result.error === 'NOT_FOUND')
          return res.status(404).json({ error: 'Member not found.' });
        if (result.error === 'OWNER')
          return res.status(409).json({ error: 'The group owner cannot be removed.' });
        return res.json({ message: 'Member removed.', userId });
      } catch (error) {
        console.error('Group member removal failed:', error.message);
        return res.status(500).json({ error: 'Unable to remove group member.' });
      }
    },
  );
}
