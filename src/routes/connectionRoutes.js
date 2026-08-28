'use strict';

const { Router } = require('express');
const connectionController = require('../controllers/connectionController');

const router = Router();

router.get('/status', connectionController.getStatus);
router.post('/rescan', connectionController.rescan);
router.post('/logout', connectionController.logout);

module.exports = router;
