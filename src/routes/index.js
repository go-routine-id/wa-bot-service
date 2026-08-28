'use strict';

const { Router } = require('express');

const router = Router();

router.use('/connection', require('./connectionRoutes'));
router.use('/templates', require('./templateRoutes'));
router.use('/media', require('./mediaRoutes'));
router.use('/broadcasts', require('./broadcastRoutes'));

module.exports = router;
