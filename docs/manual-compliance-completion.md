# Manual completion before public beta

These tasks need a human decision, the frontend repository, deployment access, or legal advice and therefore cannot be completed safely in this API repository.

- Set the real individual operator name, address/contact method, support email, privacy email and moderation email as production environment variables. Do not use a future company name until incorporation.
- Obtain Swedish/EU legal review of the Terms, Privacy Policy, Community Guidelines, organiser terms and any later paid-event/refund terms.
- Complete the processor inventory with actual providers, regions, DPAs, SCC/transfer assessments and backup providers.
- Implement the registration UI: current Terms version, a required Terms checkbox, separate Privacy link, mandatory age confirmation and optional unchecked marketing checkbox.
- Implement public/private warnings, `noindex`, sitemap filtering, safe rendering/sanitisation and the global footer in the real frontend.
- Implement a cookie banner/settings UI only after auditing the deployed frontend. Do not enable non-essential tags before consent.
- Configure an image re-encoding/EXIF-stripping, malware/safety scanning and quarantine pipeline before allowing user images broadly. The present API validates file signatures but does not provide this pipeline.
- Test every private-content path and direct media/CDN URL with anonymous, non-member, member, owner and administrator accounts.
- Establish a moderation operating procedure: trained reviewers, response times, illegal-content escalation, user notifications/statements of reasons, appeal handling and access controls.
- Choose and document concrete retention periods for messages, moderation data, reports, security logs, deleted-account records and backups. The implemented job only cleans technical tokens/invitations and marks expired posts.
- Test backup restoration, incident response, breach assessment/notification and deletion from all backups/providers.
- Keep `ENABLE_PAID_EVENTS=false`; do not enable paid events, platform fees, balances, settlement or payouts without a company/payment/legal decision.
