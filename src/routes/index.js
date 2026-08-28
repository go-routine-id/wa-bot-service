'use strict';

const { Router } = require('express');

const router = Router();

router.use('/sessions', require('./sessionRoutes'));
router.use('/templates', require('./templateRoutes'));
router.use('/media', require('./mediaRoutes'));
router.use('/broadcasts', require('./broadcastRoutes'));

module.exports = router;
