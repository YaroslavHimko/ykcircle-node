import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { ProductAccess, PUBLISH_EVENT, PUBLISH_ARTICLE, parseOwner } from '../server/product-access.js';
import { OrganizerSubscriptions, subscriptionHasAccess, subscriptionPeriod, safeReturnPath } from '../server/organizer-subscriptions.js';
import { Api } from '../server/api.js';
import { Queries } from '../server/queries.js';

function fixture() {
  const state = { configuration: { subscriptionsEnabled: true, paidEventsEnabled: false, paidVenuesEnabled: false }, members: [1], events: [], entitlements: [], subscriptions: [], customers: [], attempts: [], received: new Set(), audit: [], session: null, queries: [] };
  const execute = async (sql, p = []) => {
    state.queries.push({ sql, p });
    if (sql.includes('FROM product_configuration')) return [[{ settings: state.configuration }]];
    if (sql.startsWith('UPDATE product_configuration')) { state.configuration = JSON.parse(p[0]); return [{ affectedRows: 1 }]; }
    if (sql.includes('SELECT id FROM product_configuration')) return [[{ id: 1 }]];
    if (sql.includes('FROM organization_members')) return [state.members.includes(p[1]) ? [{ user_id: p[1] }] : []];
    if (sql.includes('FROM events WHERE deleted_at')) return [state.events];
    if (sql.startsWith('SELECT id, feature, source_type')) {
      const organization = sql.includes('organization_id=? AND user_id IS NULL');
      return [state.entitlements.filter(e => (organization ? e.organizationId === p[0] && !e.userId : e.userId === p[0] && !e.organizationId) && !e.revoked && (!e.endsAt || +new Date(e.endsAt) > Date.now()))];
    }
    if (sql.includes('FROM platform_subscriptions s')) return [state.subscriptions.filter(s => !p[1] || (s.feature || PUBLISH_EVENT) === p[1])];
    if (sql.startsWith('SELECT id, legal_name')) return [p[0] === 5 && p[1] === 1 ? [{ id: 5, name: 'Organizer', email: 'owner@example.test' }] : []];
    if (sql.startsWith('INSERT IGNORE INTO subscription_customers')) { if (!state.customers.length) state.customers.push({ owner_key: p[0], owner_type: p[1], owner_id: p[2], created_at: new Date(), provider_customer_id: null }); return [{}]; }
    if (sql.startsWith('SELECT created_at FROM subscription_customers')) return [state.customers];
    if (sql.startsWith('SELECT provider_customer_id AS id')) return [state.customers.map(c => ({ id: c.provider_customer_id }))];
    if (sql.startsWith('UPDATE subscription_customers')) { state.customers[0].provider_customer_id = p[0]; return [{}]; }
    if (sql.startsWith('SELECT * FROM subscription_checkouts')) return [state.attempts.filter(a => a.feature === p[1]).slice(-1)];
    if (sql.startsWith('INSERT INTO subscription_checkouts')) { state.attempts.push({ id: p[0], owner_key: p[1], actor_user_id: p[2], billing_profile_id: p[3], product_id: p[4], price_id: p[5], provider_price_id: p[6], return_path: p[7], feature: p[8], created_at: new Date() }); return [{}]; }
    if (sql.startsWith('UPDATE subscription_checkouts SET session_id')) { state.attempts.at(-1).session_id = p[0]; return [{}]; }
    if (sql.startsWith('SELECT c.*, customer.')) return [state.attempts.filter(a => a.id === p[0]).map(a => ({ ...a, ...state.customers[0], id: a.id }))];
    if (sql.startsWith('SELECT session_id, subscription_id')) return [state.attempts.filter(a => a.id === p[0])];
    if (sql.startsWith('SELECT price.provider_price_id')) return [[{ provider_price_id: 'price_monthly', product_id: 7 }]];
    if (sql.startsWith('INSERT INTO payment_provider_events')) { if (state.received.has(p[1])) throw Object.assign(new Error('Duplicate'), { code: 'ER_DUP_ENTRY' }); state.received.add(p[1]); return [{}]; }
    if (sql.startsWith('UPDATE payment_provider_events')) return [{}];
    if (sql.startsWith('INSERT INTO platform_subscriptions')) { state.subscriptions = [{ id: 12, status: p[5], currentPeriodEnd: new Date(p[7]*1000), providerSubscriptionId: p[11] }]; return [{ insertId: 12 }]; }
    if (sql.startsWith('UPDATE subscription_checkouts SET subscription_id')) { Object.assign(state.attempts[0], { subscription_id: p[0], session_id: p[1] }); return [{}]; }
    if (sql.startsWith('UPDATE platform_entitlements SET revoked_at')) { for (const e of state.entitlements) if (e.source === 'subscription' && e.sourceId === p[0]) e.revoked = true; return [{ affectedRows: 1 }]; }
    if (sql.startsWith('INSERT INTO platform_entitlements')) { state.entitlements.push({ id: state.entitlements.length+1, userId: p[0], organizationId: p[1], feature: p[2], source: 'subscription', sourceId: p[3], endsAt: new Date(p[4]*1000) }); return [{ insertId: state.entitlements.length }]; }
    if (sql.startsWith('INSERT INTO audit_log')) { state.audit.push(p); return [{}]; }
    if (sql.startsWith('INSERT INTO subscription_invoices')) { state.invoice = p; return [{}]; }
    throw new Error(`Unhandled fixture SQL: ${sql}`);
  };
  let queue = Promise.resolve();
  const database = { execute, getConnection: async () => {
    let releaseLock, snapshot;
    return { execute: async (sql,p) => {
      if (sql.startsWith('SELECT GET_LOCK')) { const previous = queue; queue = new Promise(resolve => { releaseLock = resolve; }); await previous; return [[{ acquired: 1 }]]; }
      if (sql.startsWith('SELECT RELEASE_LOCK')) { releaseLock?.(); return [[{ released: 1 }]]; }
      return execute(sql,p);
    }, beginTransaction: async () => { snapshot = structuredClone(state); }, commit: async () => { snapshot = null; }, rollback: async () => { if (snapshot) Object.assign(state, snapshot); }, release: () => {} };
  } };
  const calls = [];
  const subscription = { id: 'sub_organizer', customer: 'cus_platform', status: 'active', cancel_at_period_end: false, metadata: {}, items: { data: [{ price: { id: 'price_monthly' }, current_period_start: 100, current_period_end: Math.floor(Date.now()/1000)+3600 }] } };
  const stripe = { configured: () => true, stripeClient: {
    prices: { retrieve: async () => ({ active: true, type: 'recurring', recurring: { interval: 'month', interval_count: 1 }, currency: 'sek', unit_amount: 12300 }) },
    customers: { create: async (...args) => { calls.push(['customer',...args]); return { id: 'cus_platform' }; } },
    checkout: { sessions: { create: async (...args) => { calls.push(['checkout',...args]); state.session = { id: 'cs_platform', url: 'https://checkout.stripe.com/test', status: 'open', mode: 'subscription', customer: 'cus_platform', client_reference_id: args[0].client_reference_id, subscription: subscription.id }; subscription.metadata = args[0].subscription_data.metadata; return state.session; }, retrieve: async () => state.session } },
    subscriptions: { retrieve: async () => structuredClone(subscription) },
    invoices: { retrieve: async () => ({ id: 'in_1', customer: 'cus_platform', parent: { subscription_details: { subscription: subscription.id } }, status: 'paid', currency: 'sek', amount_due: 12300, amount_paid: 12300, hosted_invoice_url: 'https://invoice.stripe.com/test', invoice_pdf: null }) },
  } };
  const queries = { database, platformProducts: async () => [{ id: 7, code: 'organizer', productType: 'subscription', entitlementFeature: PUBLISH_EVENT, priceId: 8, providerPriceId: 'price_monthly', billingInterval: 'month', currency: 'SEK', amount: 123 }] };
  const service = new OrganizerSubscriptions({ queries, stripe, siteUrl: 'https://ykcircle.test' });
  const checkout = () => service.checkout({ owner: { type:'user', id:1 }, user: { id:1 }, billingProfileId:5, priceId:8, returnTo:'/profile/events/4/edit' });
  return { state, database, queries, service, calls, subscription, stripe, checkout };
}

test('article checkout is independent of event switches, subscriptions and pending checkouts', async () => {
  const f = fixture();
  const eventPlans = await f.queries.platformProducts();
  f.queries.platformProducts = async () => [...eventPlans, { ...eventPlans[0], id: 9, priceId: 10, entitlementFeature: PUBLISH_ARTICLE }];
  await f.checkout();
  f.state.configuration.subscriptionsEnabled = false;
  f.state.subscriptions.push({ status: 'active', feature: PUBLISH_EVENT });
  const input = { owner: { type: 'user', id: 1 }, user: { id: 1 }, billingProfileId: 5, priceId: 10, feature: PUBLISH_ARTICLE, returnTo: '/profile/articles/2/edit' };
  await f.service.checkout(input);
  assert.equal(f.calls.filter(call => call[0] === 'checkout').length, 2);
  assert.equal(f.state.attempts.at(-1).feature, PUBLISH_ARTICLE);
  assert.match(f.calls.at(-1)[1].success_url, /feature=author.publish_article/);
  assert.match(f.calls.at(-1)[1].success_url, /returnTo=%2Fprofile%2Farticles%2F2%2Fedit/);
  await assert.rejects(f.service.checkout({ ...input, priceId: 8 }), { code: 'PLAN_UNAVAILABLE' });
  f.state.subscriptions.push({ status: 'active', feature: PUBLISH_ARTICLE });
  await assert.rejects(f.service.checkout(input), { code: 'SUBSCRIPTION_EXISTS' });
  await assert.rejects(f.service.checkout({ ...input, owner: { type: 'organization', id: 4 } }), { code: 'ARTICLE_PERSONAL_ACCOUNT' });
});

test('article webhook grants the persisted checkout feature and revokes it after cancellation', async () => {
  const f = fixture();
  const plans = await f.queries.platformProducts();
  f.queries.platformProducts = async () => [{ ...plans[0], entitlementFeature: PUBLISH_ARTICLE }];
  await f.service.checkout({ owner: { type: 'user', id: 1 }, user: { id: 1 }, billingProfileId: 5, priceId: 8, feature: PUBLISH_ARTICLE });
  f.state.session.status = 'complete';
  const event = { id: 'evt_article', type: 'checkout.session.completed', data: { object: { id: 'cs_platform', subscription: 'sub_organizer' } } };
  await f.service.webhook(event);
  await f.service.webhook(event);
  assert.equal(f.state.entitlements.length, 1);
  assert.equal(f.state.entitlements[0].feature, PUBLISH_ARTICLE);
  assert.equal((await f.service.access.access({ type: 'user', id: 1 })).canPublish, false);
  f.subscription.status = 'canceled';
  await f.service.webhook({ ...event, id: 'evt_article_cancel' });
  assert.ok(f.state.entitlements[0].revoked);
});

test('subscription periods support the current Stripe item fields and cancellation retains access', () => {
  const { subscription } = fixture();
  assert.ok(subscriptionHasAccess(subscription));
  assert.ok(subscriptionHasAccess({ ...subscription, cancel_at_period_end: true }));
  assert.ok(subscriptionHasAccess({ ...subscription, status: 'trialing' }));
  for (const status of ['incomplete','incomplete_expired','past_due','unpaid','paused','canceled']) assert.equal(subscriptionHasAccess({ ...subscription, status }), false);
  assert.equal(subscriptionHasAccess({ ...subscription, items: { data: [] } }), false);
  assert.equal(subscriptionHasAccess(subscription, subscriptionPeriod(subscription).end), false);
});
test('owner parsing and return URLs reject cross-origin or arbitrary destinations', () => {
  assert.deepEqual(parseOwner(null,1), { type:'user',id:1 });
  assert.throws(() => parseOwner({ type:'user',id:'abc' },1));
  for (const value of ['https://evil.test','//evil.test','/admin/users','/profile/events/../admin']) assert.equal(safeReturnPath(value), '/profile/events');
  assert.equal(safeReturnPath('/profile/events/4/edit'), '/profile/events/4/edit');
});
test('event detail returns the explicit organization identity used by the editor', async () => {
  let selected;
  const queries = new Queries({ execute: async () => [[]], query: async (sql) => { selected=sql; return [[{id:4,managerId:1,organizerOrganizationId:9,locationType:'online'}]]; } });
  const event = await queries.richEvent(4,1,'organizer');
  assert.match(selected,/e\.organizer_organization_id AS organizerOrganizationId/);
  assert.equal(event.organizerOrganizationId,9);
});
test('free launch permits publication without manufacturing paid subscriptions', async () => {
  const f=fixture(); f.state.configuration.subscriptionsEnabled=false;
  f.state.events=[{ id:4, managerId:1,status:'Draft',fee:0 }];
  await f.service.access.requirePublication(4,1);
  const access=await f.service.access.access({type:'user',id:1});
  assert.equal(access.accessSource,'early_access'); assert.equal(access.canPublish,true);
  assert.deepEqual(f.state.subscriptions,[]); assert.deepEqual(f.state.entitlements,[]);
});
test('enforced publishing uses the stored owner, including when a platform manager publishes', async () => {
  const f=fixture(); f.state.events=[{ id:4,managerId:1,status:'Draft',fee:0 }];
  f.state.entitlements.push({userId:99, feature:PUBLISH_EVENT,source:'admin'});
  await assert.rejects(f.service.access.requirePublication(4,99,'manager'), {code:'SUBSCRIPTION_REQUIRED'});
  await assert.rejects(f.service.access.requirePublication(4,2,'customer'), {code:'EVENT_FORBIDDEN'});
  f.state.entitlements.push({userId:1,feature:PUBLISH_EVENT,source:'promotion'});
  await f.service.access.requirePublication(4,99,'manager');
});
test('personal and organization grants never bleed across owners; org permissions are required', async () => {
  const f=fixture(); f.state.entitlements.push({organizationId:4,feature:PUBLISH_EVENT,source:'partner'});
  assert.equal((await f.service.access.access({type:'user',id:1})).canPublish,false);
  assert.equal((await f.service.access.access({type:'organization',id:4})).canPublish,true);
  f.state.events=[{id:4,managerId:2,organizationId:4,status:'Draft',fee:0}];
  await assert.rejects(f.service.access.requirePublication(4,2,'customer'), {code:'OWNER_FORBIDDEN'});
  f.state.members.push(2); await f.service.access.requirePublication(4,2);
  f.state.entitlements=[{userId:2,feature:PUBLISH_EVENT,source:'admin'}];
  await assert.rejects(f.service.access.requirePublication(4,2), {code:'SUBSCRIPTION_REQUIRED'});
});
test('expired access blocks new publishing but already-published event operations stay available', async () => {
  const f=fixture(); f.state.entitlements=[{userId:1,feature:PUBLISH_EVENT,source:'admin',endsAt:new Date(0)}];
  f.state.events=[{id:4,managerId:1,status:'Draft',fee:0}];
  await assert.rejects(f.service.access.requirePublication(4,1),{code:'SUBSCRIPTION_REQUIRED'});
  f.state.events[0].status='Published'; await f.service.access.requirePublication(4,1);
});
test('paid-event and paid-venue controls are independent of subscription access', async () => {
  const f=fixture(); f.state.configuration.subscriptionsEnabled=false;
  f.state.events=[{id:4,managerId:1,status:'Draft',fee:50}];
  await assert.rejects(f.service.access.requirePublication(4,1),{code:'PAID_EVENTS_DISABLED'});
  await assert.rejects(f.service.access.requirePaidFeature('paidVenuesEnabled'),{code:'PAID_VENUES_DISABLED'});
  f.state.configuration.paidEventsEnabled=true; await f.service.access.requirePublication(4,1);
});
test('concurrent checkout attempts reuse one platform customer and subscription Checkout session', async () => {
  const f=fixture(); const results=await Promise.all([f.checkout(),f.checkout()]);
  assert.equal(results[0].checkoutUrl,results[1].checkoutUrl);
  assert.equal(f.calls.filter(c=>c[0]==='customer').length,1);
  assert.equal(f.calls.filter(c=>c[0]==='checkout').length,1);
  const call=f.calls.find(c=>c[0]==='checkout');
  assert.equal(call[1].mode,'subscription'); assert.equal(call[1].customer,'cus_platform');
  assert.equal(call[2].stripeAccount,undefined); assert.equal(call[1].transfer_data,undefined);
  assert.ok(call[2].idempotencyKey); assert.deepEqual(f.state.entitlements,[]);
});
test('checkout denies mismatched billing ownership and duplicate live subscriptions', async () => {
  const f=fixture();
  await assert.rejects(f.service.checkout({owner:{type:'user',id:1},user:{id:2},billingProfileId:5,priceId:8}),{code:'OWNER_FORBIDDEN'});
  await assert.rejects(f.service.checkout({owner:{type:'user',id:1},user:{id:1},billingProfileId:99,priceId:8}),{code:'BUYER_PROFILE_UNAVAILABLE'});
  for(const status of ['active','trialing','past_due','unpaid','paused','incomplete']) { f.state.subscriptions=[{status}]; await assert.rejects(f.checkout(),{code:'SUBSCRIPTION_EXISTS'}); }
  assert.deepEqual(f.calls,[]);
});
test('provider price must match configured amount, currency and recurrence', async () => {
  const f=fixture(); f.stripe.stripeClient.prices.retrieve=async()=>({active:true,type:'recurring',recurring:{interval:'year',interval_count:1},currency:'sek',unit_amount:12300});
  await assert.rejects(f.checkout(),{code:'PLAN_CONFIGURATION_MISMATCH'}); assert.deepEqual(f.calls,[]);
});
test('verified subscription reconciliation is idempotent, canonical and source-specific', async () => {
  const f=fixture(); await f.checkout(); f.state.session.status='complete';
  const event={id:'evt_1',type:'checkout.session.completed',data:{object:{id:'cs_platform',subscription:'sub_organizer'}}};
  assert.equal(await f.service.webhook({...event,account:'acct_connect'}),false);
  await f.service.webhook(event); assert.equal(f.state.subscriptions[0].status,'active');
  const grants=f.state.entitlements.length; await f.service.webhook(event); assert.equal(f.state.entitlements.length,grants);
  f.state.entitlements.push({userId:1,feature:PUBLISH_EVENT,source:'partner'});
  f.subscription.status='past_due';
  await f.service.webhook({id:'evt_2',type:'customer.subscription.updated',data:{object:{id:'sub_organizer',status:'active'}}});
  assert.equal(f.state.subscriptions[0].status,'past_due'); // ignores stale active payload
  assert.equal(f.state.entitlements.find(e=>e.source==='subscription').revoked,true);
  assert.equal(f.state.entitlements.find(e=>e.source==='partner').revoked,undefined);
  assert.equal((await f.service.access.access({type:'user',id:1})).canPublish,true);
  f.subscription.status='active';
  await f.service.webhook({id:'evt_3',type:'invoice.paid',data:{object:{id:'in_1',parent:{subscription_details:{subscription:'sub_organizer'}}}}});
  assert.equal(f.state.invoice[0],'in_1'); assert.ok(f.state.entitlements.some(e=>e.source==='subscription'&&!e.revoked));
  assert.equal(f.state.queries.some(q=>q.sql.includes('INSERT INTO invoices (')),false);
});
test('metadata alone cannot bind a different customer or Checkout to an organizer', async () => {
  const f=fixture(); await f.checkout(); f.state.session.status='complete'; f.subscription.customer='cus_other';
  const event={id:'evt_1',type:'customer.subscription.created',data:{object:{id:'sub_organizer'}}};
  await assert.rejects(f.service.webhook(event),{code:'SUBSCRIPTION_IDENTITY_MISMATCH'});
  f.subscription.customer='cus_platform'; f.state.session.client_reference_id='different';
  await assert.rejects(f.service.webhook(event),{code:'CHECKOUT_IDENTITY_MISMATCH'});
  assert.deepEqual(f.state.entitlements,[]); assert.equal(f.state.received.size,0);
});
test('ambiguous checkout timeouts reuse the persisted idempotency key and return path', async () => {
  const f=fixture(); const create=f.stripe.stripeClient.checkout.sessions.create; let failed=false;
  f.stripe.stripeClient.checkout.sessions.create=async(...args)=>{const session=await create(...args); if(!failed){failed=true;throw new Error('Timeout after creation');}return session;};
  await assert.rejects(f.checkout(),/Timeout/); assert.equal(f.state.attempts.length,1);
  await f.checkout(); const calls=f.calls.filter(call=>call[0]==='checkout');assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.equal(f.state.attempts.length,1);
});
test('out-of-order cancellation and failed invoices reconcile current status without reviving access', async () => {
  const f=fixture(); await f.checkout();f.state.session.status='complete';f.subscription.status='canceled';
  await f.service.webhook({id:'evt_deleted',type:'customer.subscription.deleted',data:{object:{id:'sub_organizer'}}});
  await f.service.webhook({id:'evt_old_active',type:'customer.subscription.updated',data:{object:{id:'sub_organizer',status:'active'}}});
  assert.equal(f.state.subscriptions[0].status,'canceled');assert.equal(f.state.entitlements.length,0);
  f.subscription.status='past_due';
  await f.service.webhook({id:'evt_failed_invoice',type:'invoice.payment_failed',data:{object:{id:'in_1',parent:{subscription_details:{subscription:'sub_organizer'}}}}});
  assert.equal(f.state.subscriptions[0].status,'past_due');assert.equal(f.state.entitlements.length,0);
});
test('plan mismatch is retryable and does not consume a webhook or change existing grants', async () => {
  const f=fixture();await f.checkout();f.state.session.status='complete';f.subscription.items.data[0].price.id='price_wrong';
  const event={id:'evt_retry',type:'customer.subscription.updated',data:{object:{id:'sub_organizer'}}};
  await assert.rejects(f.service.webhook(event),{code:'SUBSCRIPTION_PLAN_MISMATCH'});assert.equal(f.state.received.size,0);
  f.subscription.items.data[0].price.id='price_monthly';await f.service.webhook(event);assert.equal(f.state.entitlements.length,1);
});

async function apiFixture(t) {
  const f=fixture(); const secret='test-subscription-auth-secret-more-than-thirty-two';
  const event={id:4,managerId:1,title:'A free online event',description:'Details',categoryId:1,typeId:1,locationType:'online',startsAt:'2030-05-01T10:00:00Z',timezone:'UTC',fee:0,pricingType:'free',coverImage:'/uploads/test/cover.jpg',status:'Draft',visibility:'Public'};
  f.state.events=[event];
  Object.assign(f.queries,{initialize:async()=>{},findUserById:async id=>({id,role:id===99?'manager':'customer',isEmailConfirmed:true,sessionVersion:1}),richEvent:async()=>event,
    createRichEventSeries:async()=>({eventIds:[4],seriesId:null}),updateRichEventAndBooking:async()=>true,publishRichEvent:async()=>{event.status='Published';},updateEventStatus:async()=>{event.status='Published';return true;},recordLocationActivity:async()=>{},audit:async()=>{} });
  const ftp={publicPath:()=>'/uploads/test'};
  const api=new Api({config:{site:{siteUrl:'https://ykcircle.test'},runtime:{authSecret:secret,stripe:{secretKey:'sk_test_fake',webhookSecret:'whsec_subs'}}},queries:f.queries,database:f.database,emailService:{},ftpService:ftp,eventFtpService:ftp,venueFtpService:ftp,groupFtpService:ftp,articleFtpService:ftp});
  api.subscriptions.stripe.stripeClient=f.stripe.stripeClient;
  const app=express(); app.use('/api/payment-webhooks/stripe',express.raw({type:'application/json'})); api.registerPaymentWebhooks(app); app.use(express.json()); api.register(app);
  const server=app.listen(0); await new Promise(resolve=>server.once('listening',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,body,method='POST',id=1)=>{const payload=Buffer.from(JSON.stringify({id,sessionVersion:1,exp:Date.now()+60000})).toString('base64url');const token=payload+'.'+crypto.createHmac('sha256',secret).update(payload).digest('base64url');return fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});};
  return {...f,event,request,base,api};
}
test('HTTP draft creation remains allowed; both publishing APIs enforce the subscription and redirect contract', async t=>{
  const f=await apiFixture(t);
  const draft=await f.request('/api/events/drafts',{...f.event,coverImage:undefined}); assert.equal(draft.status,201,await draft.text());
  for(const [path,method,body] of [['/api/events/4/publish','POST',{}],['/api/events/4/status','PATCH',{status:'Published'}]]) {
    const response=await f.request(path,body,method); assert.equal(response.status,403); const data=await response.json(); assert.equal(data.code,'SUBSCRIPTION_REQUIRED');assert.match(data.subscribeUrl,/^\/subscribe\?/);
  }
  f.state.configuration.subscriptionsEnabled=false; const published=await f.request('/api/events/4/publish',{}); assert.equal(published.status,200,await published.text());
});
test('HTTP paid-feature bypasses are denied even for managers; configuration is staff-only', async t=>{
  const f=await apiFixture(t);
  for(const [path,body,method] of [['/api/events/drafts',{pricingType:'paid',fee:5},'POST'],['/api/groups/2/events/drafts',{fee:5},'POST'],['/api/events/4/payment-settings',{paymentsEnabled:true},'PUT'],['/api/events/4/ticket-checkout',{},'POST'],['/api/ticket-orders/1/checkout',{},'POST'],['/api/venues',{priceFrom:50},'POST'],['/api/venues/2/booking-settings',{hourlyRate:50},'PUT']]) {
    const response=await f.request(path,body,method,99);assert.equal(response.status,403,`${path}: ${await response.text()}`);
  }
  assert.equal((await f.request('/api/admin/configuration',{subscriptionsEnabled:false},'PUT')).status,403);
  const changed=await f.request('/api/admin/configuration',{subscriptionsEnabled:false},'PUT',99);assert.equal(changed.status,200,await changed.text());assert.equal(f.state.configuration.subscriptionsEnabled,false);assert.equal(f.state.audit.length,1);
});
test('paid feature checks follow Express route matching for casing, trailing slashes and encoded IDs', async t=>{
  const f=await apiFixture(t);
  for(const [path,body,method] of [['/api/EVENTS/DRAFTS/',{fee:5},'POST'],['/api/groups/%32/events/drafts/',{pricingType:'paid'},'POST'],['/api/events/%34/payment-settings/',{paymentsEnabled:true},'PUT'],['/api/venues/%32/booking-settings/',{dailyRate:50},'PUT'],['/api/TICKET-ORDERS/1/CHECKOUT/',{},'POST']]){
    const response=await f.request(path,body,method,99);assert.equal(response.status,403,`${path}: ${await response.text()}`);
  }
});
test('HTTP subscription webhook signatures reject tampering and redirects never activate access', async t=>{
  const f=await apiFixture(t); await f.checkout(); f.state.session.status='complete';
  const body=JSON.stringify({id:'evt_signed',type:'checkout.session.completed',data:{object:{id:'cs_platform',subscription:'sub_organizer'}}});
  const time=Math.floor(Date.now()/1000), signature=`t=${time},v1=${crypto.createHmac('sha256','whsec_subs').update(`${time}.${body}`).digest('hex')}`;
  let response=await fetch(f.base+'/api/payment-webhooks/stripe',{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':signature},body:body+' '});assert.equal(response.status,400); assert.equal(f.state.entitlements.length,0);
  response=await fetch(f.base+'/api/payment-webhooks/stripe',{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':signature},body});assert.equal(response.status,200,await response.text()); assert.equal(f.state.entitlements.length,1);
});
