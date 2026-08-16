# Persistent FTP image storage on Hostinger

Hostinger redeploys a Node.js application's `nodejs` build directory. Do not
store uploaded images anywhere in that directory: the next deployment can
replace it. This API proxies FTP images, so their FTP directory is persistent
storage and must be kept separate from the deployed application.

In hPanel's **File Manager**, choose **Access all files** and create these
directories under the domain's `public_html` directory:

```text
public_html/uploads/profile-pictures
public_html/uploads/event-covers
public_html/uploads/group-covers
public_html/uploads/article-images
```

Set these production environment variables in the Node.js app, then redeploy:

```text
FTP_PROFILE_UPLOAD_PATH=/public_html/uploads/profile-pictures
FTP_EVENT_UPLOAD_PATH=/public_html/uploads/event-covers
FTP_GROUP_UPLOAD_PATH=/public_html/uploads/group-covers
FTP_ARTICLE_UPLOAD_PATH=/public_html/uploads/article-images
```

For an FTP account that is already chrooted to `public_html`, remove the
`/public_html` prefix instead (for example,
`/uploads/article-images`). Confirm the account root in FileZilla or hPanel
before choosing the form to use.

Do not use paths containing `nodejs`. The application rejects them at startup
to prevent a deployment from silently deleting newly uploaded media.

Hostinger's Node.js deployments keep the application build outside
`public_html`; `public_html` contains the generated routing configuration.
Keep the media directories above in place and do not use a deployment command
that deletes `public_html/uploads`.

If you deploy with an FTP/SFTP sync tool instead of Hostinger's Node.js Git
deployment, configure it to exclude `uploads/**` and disable remote deletion.
Otherwise the sync tool, rather than this API, will purge the media directory.
