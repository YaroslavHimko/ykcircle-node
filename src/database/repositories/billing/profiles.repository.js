export class BillingProfilesRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  billingProfileColumns(prefix = 'p') {
    return `${prefix}.id, ${prefix}.owner_user_id AS ownerUserId, ${prefix}.owner_organization_id AS ownerOrganizationId,
      ${prefix}.profile_type AS profileType, ${prefix}.legal_name AS legalName, ${prefix}.organization_number AS organizationNumber,
      ${prefix}.vat_number AS vatNumber, ${prefix}.address_line_1 AS addressLine1, ${prefix}.address_line_2 AS addressLine2,
      ${prefix}.postal_code AS postalCode, ${prefix}.city, ${prefix}.country, ${prefix}.billing_email AS billingEmail,
      ${prefix}.phone, ${prefix}.default_currency AS defaultCurrency, ${prefix}.invoice_prefix AS invoicePrefix,
      ${prefix}.invoice_due_days AS invoiceDueDays, ${prefix}.payment_instructions AS paymentInstructions,
      ${prefix}.is_default AS isDefault, ${prefix}.is_active AS isActive, ${prefix}.created_at AS createdAt, ${prefix}.updated_at AS updatedAt`;
  }

  async billingProfiles(userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT ${this.queries.billingProfileColumns('p')}
      FROM billing_profiles p LEFT JOIN organization_members member ON member.organization_id=p.owner_organization_id AND member.user_id=?
      WHERE p.is_active=TRUE AND (p.owner_user_id=? OR member.role IN ('owner','admin') OR ${privileged ? 'TRUE' : 'FALSE'})
      ORDER BY p.is_default DESC, p.updated_at DESC`,
      [userId, userId],
    );
    return rows.map((row) => ({
      ...row,
      isDefault: Boolean(row.isDefault),
      isActive: Boolean(row.isActive),
    }));
  }

  async billingProfile(profileId, userId, role, connection = this.database) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await connection.execute(
      `SELECT ${this.queries.billingProfileColumns('p')} FROM billing_profiles p
      LEFT JOIN organization_members member ON member.organization_id=p.owner_organization_id AND member.user_id=?
      WHERE p.id=? AND p.is_active=TRUE AND (p.owner_user_id=? OR member.role IN ('owner','admin') OR ${privileged ? 'TRUE' : 'FALSE'})`,
      [userId, profileId, userId],
    );
    return rows[0]
      ? { ...rows[0], isDefault: Boolean(rows[0].isDefault), isActive: Boolean(rows[0].isActive) }
      : null;
  }

  async saveBillingProfile(userId, role, profileId, profile) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const organizationId = profile.ownerOrganizationId
        ? Number(profile.ownerOrganizationId)
        : null;
      // Organization billing details are financial records.  A regular
      // organization manager can operate the organization, but cannot change
      // its legal billing identity; that remains with an owner/admin (or a
      // platform manager/admin).
      if (organizationId && !['manager', 'admin'].includes(role)) {
        const member = await this.queries.organizationMember(organizationId, userId);
        if (!member || !['owner', 'admin'].includes(member.role)) {
          await connection.rollback();
          return null;
        }
      }
      const existing = profileId
        ? await this.queries.billingProfile(profileId, userId, role, connection)
        : null;
      if (
        profileId &&
        (!existing ||
          Number(existing.ownerOrganizationId || 0) !== Number(organizationId || 0) ||
          (!organizationId && Number(existing.ownerUserId) !== Number(userId)))
      ) {
        await connection.rollback();
        return null;
      }
      const ownerUserId = organizationId ? null : userId;
      if (profile.isDefault)
        await connection.execute(
          `UPDATE billing_profiles SET is_default=FALSE WHERE ${organizationId ? 'owner_organization_id=?' : 'owner_user_id=?'}`,
          [organizationId || userId],
        );
      const fields = [
        profile.profileType,
        profile.legalName,
        profile.organizationNumber,
        profile.vatNumber,
        profile.addressLine1,
        profile.addressLine2,
        profile.postalCode,
        profile.city,
        profile.country,
        profile.billingEmail,
        profile.phone,
        profile.defaultCurrency,
        profile.invoicePrefix,
        profile.invoiceDueDays,
        profile.paymentInstructions,
        profile.isDefault,
      ];
      let id = profileId;
      if (id)
        await connection.execute(
          `UPDATE billing_profiles SET profile_type=?, legal_name=?, organization_number=?, vat_number=?, address_line_1=?, address_line_2=?, postal_code=?, city=?, country=?, billing_email=?, phone=?, default_currency=?, invoice_prefix=?, invoice_due_days=?, payment_instructions=?, is_default=? WHERE id=?`,
          [...fields, id],
        );
      else {
        const [result] = await connection.execute(
          `INSERT INTO billing_profiles (owner_user_id, owner_organization_id, profile_type, legal_name, organization_number, vat_number, address_line_1, address_line_2, postal_code, city, country, billing_email, phone, default_currency, invoice_prefix, invoice_due_days, payment_instructions, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ownerUserId, organizationId, ...fields],
        );
        id = result.insertId;
      }
      if (organizationId && profile.isDefault)
        await connection.execute(
          'UPDATE organizations SET default_billing_profile_id=? WHERE id=?',
          [id, organizationId],
        );
      await connection.commit();
      return this.queries.billingProfile(id, userId, role);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async archiveBillingProfile(profileId, userId, role) {
    const profile = await this.queries.billingProfile(profileId, userId, role);
    if (!profile) return false;
    // Archiving is intentionally allowed even for a profile referenced by an
    // issued invoice or order. Those records retain their immutable snapshots;
    // `is_active` only prevents new financial use of the profile.
    await this.database.execute(
      'UPDATE billing_profiles SET is_active=FALSE, is_default=FALSE WHERE id=?',
      [profileId],
    );
    await this.database.execute(
      'UPDATE organizations SET default_billing_profile_id=NULL WHERE default_billing_profile_id=?',
      [profileId],
    );
    return true;
  }

  async paymentAccounts(billingProfileId, userId, role) {
    if (!(await this.queries.billingProfile(billingProfileId, userId, role))) return null;
    const [rows] = await this.database.execute(
      `SELECT id, billing_profile_id AS billingProfileId, provider, provider_account_id AS providerAccountId,
      onboarding_status AS onboardingStatus, charges_enabled AS chargesEnabled, payouts_enabled AS payoutsEnabled, details_submitted AS detailsSubmitted, country,
      default_currency AS defaultCurrency, created_at AS createdAt, updated_at AS updatedAt FROM payment_accounts WHERE billing_profile_id=?`,
      [billingProfileId],
    );
    return rows.map((row) => ({
      ...row,
      chargesEnabled: Boolean(row.chargesEnabled),
      payoutsEnabled: Boolean(row.payoutsEnabled),
      detailsSubmitted: row.detailsSubmitted == null ? null : Boolean(row.detailsSubmitted),
    }));
  }

  async createPaymentAccount(billingProfileId, userId, role, account) {
    const profile = await this.queries.billingProfile(billingProfileId, userId, role);
    if (!profile) return null;
    const [result] = await this.database.execute(
      `INSERT INTO payment_accounts
      (billing_profile_id, provider, provider_account_id, onboarding_status, charges_enabled, payouts_enabled, details_submitted, country, default_currency)
      VALUES (?, ?, ?, 'pending', FALSE, FALSE, FALSE, ?, ?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [
        billingProfileId,
        account.provider,
        account.providerAccountId,
        profile.country,
        profile.defaultCurrency,
      ],
    );
    await this.queries.audit(
      userId,
      'payment_account_connected',
      'payment_account',
      result.insertId,
      { billingProfileId, provider: account.provider },
    );
    return {
      id: result.insertId,
      billingProfileId,
      provider: account.provider,
      providerAccountId: account.providerAccountId,
      onboardingStatus: 'pending',
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      country: profile.country,
      defaultCurrency: profile.defaultCurrency,
    };
  }

  async updatePaymentAccountCapabilities(provider, providerAccountId, capabilities) {
    const [result] = await this.database.execute(
      `UPDATE payment_accounts SET onboarding_status=?, charges_enabled=?, payouts_enabled=?, details_submitted=?
      WHERE provider=? AND provider_account_id=?`,
      [
        capabilities.onboardingStatus,
        Boolean(capabilities.chargesEnabled),
        Boolean(capabilities.payoutsEnabled),
        capabilities.detailsSubmitted == null ? null : Boolean(capabilities.detailsSubmitted),
        provider,
        providerAccountId,
      ],
    );
    return result.affectedRows > 0;
  }

  async paymentAccount(accountId, userId, role) {
    const [rows] = await this.database.execute(
      `SELECT account.id, account.billing_profile_id AS billingProfileId, account.provider,
      account.provider_account_id AS providerAccountId, account.onboarding_status AS onboardingStatus, account.charges_enabled AS chargesEnabled,
      account.payouts_enabled AS payoutsEnabled, account.details_submitted AS detailsSubmitted, account.country, account.default_currency AS defaultCurrency
      FROM payment_accounts account JOIN billing_profiles profile ON profile.id=account.billing_profile_id
      LEFT JOIN organization_members member ON member.organization_id=profile.owner_organization_id AND member.user_id=?
      WHERE account.id=? AND (profile.owner_user_id=? OR member.role IN ('owner','admin') OR ${['manager', 'admin'].includes(role) ? 'TRUE' : 'FALSE'})`,
      [userId, accountId, userId],
    );
    return rows[0]
      ? {
          ...rows[0],
          chargesEnabled: Boolean(rows[0].chargesEnabled),
          payoutsEnabled: Boolean(rows[0].payoutsEnabled),
          detailsSubmitted:
            rows[0].detailsSubmitted == null ? null : Boolean(rows[0].detailsSubmitted),
        }
      : null;
  }
}
