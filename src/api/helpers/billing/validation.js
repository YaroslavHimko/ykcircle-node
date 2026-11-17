export function createBillingValidation({ config }) {
  const textField = (body, key, max = 255) =>
    body[key] == null ? null : String(body[key]).trim().slice(0, max) || null;
  const sameSiteUrl = (value) => {
    try {
      return new URL(value).origin === new URL(config.site.siteUrl).origin;
    } catch {
      return false;
    }
  };
  const billingProfileData = (body) => {
    const data = Object.fromEntries(
      [
        'legalName',
        'organizationNumber',
        'vatNumber',
        'addressLine1',
        'addressLine2',
        'postalCode',
        'city',
        'country',
        'billingEmail',
        'phone',
        'paymentInstructions',
      ].map((key) => [key, textField(body, key, key === 'paymentInstructions' ? 5000 : 255)]),
    );
    data.profileType = String(body.profileType || 'individual');
    data.ownerOrganizationId = body.ownerOrganizationId ? Number(body.ownerOrganizationId) : null;
    data.defaultCurrency =
      body.defaultCurrency == null || body.defaultCurrency === ''
        ? null
        : String(body.defaultCurrency).trim().toUpperCase();
    data.invoicePrefix = String(body.invoicePrefix || 'INV')
      .trim()
      .toUpperCase();
    data.invoiceDueDays = Number(body.invoiceDueDays ?? 30);
    data.isDefault = Boolean(body.isDefault);
    const errors = {};
    for (const key of [
      'legalName',
      'addressLine1',
      'postalCode',
      'city',
      'country',
      'billingEmail',
    ])
      if (!data[key]) errors[key] = 'This field is required.';
    if (!['individual', 'organization'].includes(data.profileType))
      errors.profileType = 'Profile type must be individual or organization.';
    if (
      data.ownerOrganizationId &&
      (!Number.isInteger(data.ownerOrganizationId) || data.ownerOrganizationId < 1)
    )
      errors.ownerOrganizationId = 'Choose a valid organization.';
    if (data.ownerOrganizationId && data.profileType !== 'organization')
      errors.profileType =
        'An organization billing profile must use the organization profile type.';
    if (!data.ownerOrganizationId && data.profileType !== 'individual')
      errors.profileType = 'A personal billing profile must use the individual profile type.';
    if (data.billingEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.billingEmail))
      errors.billingEmail = 'Enter a valid billing email address.';
    if (data.defaultCurrency && !/^[A-Z]{3}$/.test(data.defaultCurrency))
      errors.defaultCurrency = 'Currency must be a three-letter ISO code.';
    if (!/^[A-Z0-9-]{1,20}$/.test(data.invoicePrefix))
      errors.invoicePrefix = 'Invoice prefix must use 1-20 letters, digits, or hyphens.';
    if (
      !Number.isInteger(data.invoiceDueDays) ||
      data.invoiceDueDays < 0 ||
      data.invoiceDueDays > 365
    )
      errors.invoiceDueDays = 'Invoice due days must be 0-365.';
    return { data, errors };
  };
  return { sameSiteUrl, billingProfileData };
}
