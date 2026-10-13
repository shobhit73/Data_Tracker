/**
 * doc_mails.test.js — runs the REAL Code.gs doc-mail functions under node vm,
 * with GmailApp / UrlFetchApp / PropertiesService / Utilities stubbed.
 *
 * Same idea as the syncAuditCoverage_ harness (commit de441fe): a Python or
 * pseudo re-implementation of the logic proves nothing about the file that
 * actually runs, so this loads Config.gs + Code.gs verbatim and exercises:
 *
 *   - dtParseDocMail_ against the real mail bodies quoted in
 *     scripts/populate_documents_from_mail*.py (every shape the thread used)
 *   - dtStripQuoted_: an acknowledgement quoting a real report must parse null
 *   - dtCanonicalName_: mail shorthand -> the table's spelling; ambiguity
 *     keeps the mail's own spelling
 *   - syncDocumentTransferMails_ end to end: id dedupe, the date window,
 *     insert-only on an existing client, the Spelman-style prose going to the
 *     "needs a human" log, dry run writing nothing, the real run POSTing
 *     exactly the new rows
 *
 * Run: node apps-script/tests/doc_mails.test.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

/* ---------------------------------------------------------------- stubs */

var state = {
  posts: [],          // every POST body sent to our Supabase
  gmailQueries: [],
  existingRows: [],   // GET document_transfer answer
  auditRows: [],      // GET audit_coverage answer
  threads: []
};

function response(code, text) {
  return {
    getResponseCode: function () { return code; },
    getContentText: function () { return text; }
  };
}

var ctx = {
  console: { log: function () { /* quiet; tests assert on return values */ } },
  PropertiesService: {
    getScriptProperties: function () {
      return {
        getProperty: function (k) {
          if (k === 'DASH_URL') return 'https://dash.test.supabase.co';
          if (k === 'DASH_SERVICE_KEY') return 'test-key-not-a-real-secret';
          return null;
        }
      };
    }
  },
  UrlFetchApp: {
    fetch: function (url, opts) {
      opts = opts || {};
      var method = String(opts.method || 'get').toLowerCase();
      if (method === 'get' && url.indexOf('/rest/v1/document_transfer') !== -1) {
        return response(200, JSON.stringify(state.existingRows));
      }
      if (method === 'get' && url.indexOf('/rest/v1/audit_coverage') !== -1) {
        return response(200, JSON.stringify(state.auditRows));
      }
      if (method === 'post' && url.indexOf('/rest/v1/document_transfer') !== -1) {
        state.posts.push(JSON.parse(opts.payload));
        return response(201, '');
      }
      return response(500, 'unexpected fetch ' + method + ' ' + url);
    }
  },
  GmailApp: {
    search: function (query) {
      state.gmailQueries.push(query);
      return state.threads;
    }
  },
  Utilities: {
    formatDate: function (d, tz, fmt) {
      // yyyy-MM-dd in IST is all the code under test asks for.
      return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    }
  }
};
vm.createContext(ctx);

var dir = path.join(__dirname, '..');
['Config.gs', 'Code.gs'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
});

function msg(id, iso, from, body) {
  return {
    getId: function () { return id; },
    getDate: function () { return new Date(iso); },
    getFrom: function () { return from; },
    getPlainBody: function () { return body; }
  };
}
function thread(messages) {
  return { getMessages: function () { return messages; } };
}

/* ------------------------------------------------------------ framework */

var failures = 0, ran = 0;
function t(name, fn) {
  ran++;
  try {
    fn();
    console.log('PASS  ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL  ' + name + '\n      ' + e.message);
  }
}
function eq(got, want, what) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error((what || 'value') + ': got ' + g + ', want ' + w);
}

/* ------------------------------------------- parser: the real mail bodies */

t('shape A: "All documents ... of CDC Logistics to UZIO." (msg 1a05c5fc45f8a4a5)', function () {
  var p = ctx.dtParseDocMail_(
    'Hi Team,\n\nAll documents have been uploaded successfully of CDC Logistics to UZIO.\n\nThanks,\nRohit');
  eq(p.client_name, 'CDC Logistics', 'client');
  eq(p.status, 'Complete', 'status');
  eq(p.total_docs, null, 'total');
  eq(p.failed_docs, null, 'failed');
});

t('shape A: Beck Logistics (msg 1a0669d6f0c10ea8)', function () {
  var p = ctx.dtParseDocMail_(
    'All documents have been uploaded successfully of Beck Logistics to UZIO.');
  eq(p.client_name, 'Beck Logistics', 'client');
  eq(p.status, 'Complete', 'status');
});

t('shape B: "The documents for High Distinction Logistics LLC have been uploaded." (msg 1a03ddea53fe6450)', function () {
  var p = ctx.dtParseDocMail_(
    'The documents for High Distinction Logistics LLC have been uploaded.');
  eq(p.client_name, 'High Distinction Logistics LLC', 'client');
  eq(p.status, 'Complete', 'status');
  eq(p.total_docs, null, 'total');
});

t('shape C: "InnovDel documents have been uploaded successfully today" (msg of 08/13)', function () {
  var p = ctx.dtParseDocMail_(
    'Hi Team,\n\nInnovDel documents have been uploaded successfully today.\n\nRegards');
  eq(p.client_name, 'InnovDel', 'client');
  eq(p.total_docs, null, 'total');
  eq(p.failed_docs, null, 'failed');
});

t('shape C + no-errors statement: North Star (msg of 07/08) records failed = 0', function () {
  var p = ctx.dtParseDocMail_(
    'North Star Parcel Documents are uploaded successfully without any errors');
  eq(p.client_name, 'North Star Parcel', 'client');
  eq(p.failed_docs, 0, 'failed');
  eq(p.total_docs, null, 'total: no count stated, none recorded');
  eq(p.status, 'Complete', 'status');
});

t('stated counts are taken; failed > 0 makes it Completed with issues', function () {
  var p = ctx.dtParseDocMail_(
    'All documents have been uploaded successfully of Foo Delivery to UZIO. ' +
    'Total documents: 943. Failed: 2.');
  eq(p.total_docs, 943, 'total');
  eq(p.failed_docs, 2, 'failed');
  eq(p.status, 'Completed with issues', 'status');
});

t('acknowledgement parses to null', function () {
  eq(ctx.dtParseDocMail_('Thank you for the update.'), null);
});

t('a reply quoting a real report parses to null (quoted history stripped)', function () {
  var p = ctx.dtParseDocMail_(
    'Thank you for the update.\n\n' +
    'On Thu, Sep 3, 2026 at 9:12 AM Rohit Kaushik <rohit.kaushik@uzio.com> wrote:\n' +
    '> All documents have been uploaded successfully of Beck Logistics to UZIO.\n');
  eq(p, null);
});

t('Spelman-style partial-failure prose parses to null (a human must read it)', function () {
  var p = ctx.dtParseDocMail_(
    'Document upload status for Spelman Logistics:\n' +
    '5,366 files, 4,497 uploaded (84%), 869 not uploaded (16%).\n' +
    '808 company-wide documents with no employee to file them under, ' +
    '56 for terminated/unknown employees, 3 format issues (2 .ZIP, 1 old .DOC).');
  eq(p, null);
});

t('"All documents are uploaded successfully" names nobody -> null', function () {
  eq(ctx.dtParseDocMail_('All documents are uploaded successfully.'), null);
});

/* ----------------------------------------------------- canonical naming */

t('canonical name: mail shorthand maps to the table spelling', function () {
  var names = ['CDC LOGISTICS, LLC', 'Beck Logistics LLC', 'InnovDel Inc'];
  eq(ctx.dtCanonicalName_('CDC Logistics', names), 'CDC LOGISTICS, LLC');
  eq(ctx.dtCanonicalName_('Beck Logistics', names), 'Beck Logistics LLC');
  eq(ctx.dtCanonicalName_('InnovDel', names), 'InnovDel Inc');
});

t('canonical name: unknown client keeps the mail spelling', function () {
  eq(ctx.dtCanonicalName_('Zoom Logistics', ['CDC LOGISTICS, LLC']), 'Zoom Logistics');
});

t('canonical name: two candidates claiming the name keeps the mail spelling', function () {
  eq(ctx.dtCanonicalName_('Delta', ['Delta Logistics LLC', 'Delta Transport Inc']), 'Delta');
});

/* ------------------------------------------------------------ end to end */

function seedSync() {
  state.posts = [];
  state.gmailQueries = [];
  state.existingRows = [
    { id: 1, client_name: 'CDC LOGISTICS, LLC', status: 'Complete',
      transfer_date: '2026-09-01', total_docs: null, failed_docs: null,
      source_message_id: '19e87c8359be7407' },   // the old thread-id style
    { id: 2, client_name: 'Beck Logistics LLC', status: 'Complete',
      transfer_date: '2026-09-03', total_docs: null, failed_docs: null,
      source_message_id: '1a0669d6f0c10ea8' }
  ];
  state.auditRows = [
    { client_name: 'Zoom Logistics LLC', audit_category: 'Census', status: 'Present' },
    { client_name: 'CDC LOGISTICS, LLC', audit_category: 'Census', status: 'Present' }
  ];
  state.threads = [thread([
    // already imported: its id is on row 2 -> skipped
    msg('1a0669d6f0c10ea8', '2026-09-03T05:00:00Z', 'Rohit Kaushik <rohit.kaushik@uzio.com>',
        'All documents have been uploaded successfully of Beck Logistics to UZIO.'),
    // acknowledgement quoting that report -> nothing
    msg('msg_ack1', '2026-10-10T05:00:00Z', 'Mercedes Hallback <m@uzio.com>',
        'Thank you for the update.\n\nOn Thu, Sep 3, 2026 Rohit Kaushik wrote:\n' +
        '> All documents have been uploaded successfully of Beck Logistics to UZIO.'),
    // new client, shorthand name -> ONE insert under the audit_coverage spelling
    msg('msg_new1', '2026-10-11T05:00:00Z', 'Rohit Kaushik <rohit.kaushik@uzio.com>',
        'Hi Team,\n\nAll documents have been uploaded successfully of Zoom Logistics to UZIO.\n\nThanks'),
    // newer mail about an existing client -> insert-only, kept as is
    msg('msg_cdc2', '2026-10-12T05:00:00Z', 'Rohit Kaushik <rohit.kaushik@uzio.com>',
        'All documents have been uploaded successfully of CDC Logistics to UZIO.'),
    // partial-failure prose -> needs-a-human line, no row
    msg('msg_spel2', '2026-10-12T06:00:00Z', 'Rohit Kaushik <rohit.kaushik@uzio.com>',
        'Document upload status for Spelman Logistics: 5,366 files, 4,497 uploaded (84%), 869 not uploaded (16%).')
  ])];
}

t('sync dry run: plans one insert, writes nothing', function () {
  seedSync();
  var log = ctx.syncDocumentTransferMails_(true).join('\n');
  eq(state.posts.length, 0, 'POSTs');
  if (log.indexOf('1 new transfer(s)') === -1) throw new Error('log: ' + log);
  if (log.indexOf('+ Zoom Logistics LLC 2026-10-11') === -1) throw new Error('log: ' + log);
  if (log.indexOf('DRY RUN') === -1) throw new Error('log: ' + log);
});

t('sync real run: inserts exactly the Zoom row, canonically named', function () {
  seedSync();
  var log = ctx.syncDocumentTransferMails_(false).join('\n');
  eq(state.posts.length, 1, 'POST calls');
  eq(state.posts[0].length, 1, 'rows in the POST');
  var r = state.posts[0][0];
  eq(r.client_name, 'Zoom Logistics LLC', 'client');
  eq(r.status, 'Complete', 'status');
  eq(r.transfer_date, '2026-10-11', 'date');
  eq(r.total_docs, null, 'total');
  eq(r.failed_docs, null, 'failed');
  eq(r.source_message_id, 'msg_new1', 'source');
  if (String(r.notes).indexOf('no document counts') === -1) {
    throw new Error('notes should say counts were deliberately left blank: ' + r.notes);
  }
  if (log.indexOf('Wrote 1 row(s)') === -1) throw new Error('log: ' + log);
});

t('sync: existing client is never rewritten, and is said so in the log', function () {
  seedSync();
  var log = ctx.syncDocumentTransferMails_(false).join('\n');
  if (log.indexOf('= CDC LOGISTICS, LLC') === -1) throw new Error('log: ' + log);
  state.posts.forEach(function (batch) {
    batch.forEach(function (r) {
      if (r.client_name.indexOf('CDC') !== -1) throw new Error('CDC was written');
    });
  });
});

t('sync: unparsed upload mail lands in the needs-a-human log', function () {
  seedSync();
  var log = ctx.syncDocumentTransferMails_(false).join('\n');
  if (log.indexOf('needs a human') === -1 || log.indexOf('Spelman') === -1) {
    throw new Error('log: ' + log);
  }
});

t('sync: Gmail search is bounded by the newest transfer_date', function () {
  seedSync();
  ctx.syncDocumentTransferMails_(true);
  var q = state.gmailQueries[0];
  eq(q, 'subject:"Document Upload Status" after:2026/09/03', 'query');
});

t('sync: empty table falls back to the default window', function () {
  seedSync();
  state.existingRows = [];
  ctx.syncDocumentTransferMails_(true);
  var q = state.gmailQueries[0];
  eq(q, 'subject:"Document Upload Status" newer_than:90d', 'query');
});

t('sync: two mails about the same new client in one run insert once', function () {
  seedSync();
  state.threads = [thread([
    msg('msg_a', '2026-10-11T05:00:00Z', 'r@uzio.com',
        'All documents have been uploaded successfully of Zoom Logistics to UZIO.'),
    msg('msg_b', '2026-10-11T07:00:00Z', 'r@uzio.com',
        'All documents have been uploaded successfully of Zoom Logistics to UZIO.')
  ])];
  ctx.syncDocumentTransferMails_(false);
  eq(state.posts.length, 1, 'POST calls');
  eq(state.posts[0].length, 1, 'rows');
});

/* ----------------------------------------------------------------- done */

console.log('\n' + (ran - failures) + '/' + ran + ' passed');
process.exit(failures ? 1 : 0);
