'use strict';

const { RECIPIENT_STATUSES } = require('./broadcast');

const Recipient = {
  STATUS_PENDING: 'pending',
  STATUS_SENDING: 'sending',
  STATUS_SENT: 'sent',
  STATUS_FAILED: 'failed',
  STATUS_SKIPPED: 'skipped',

  isKnownStatus(status) {
    return RECIPIENT_STATUSES.includes(status);
  },
};

module.exports = Recipient;
