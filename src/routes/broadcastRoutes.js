'use strict';

const { Router } = require('express');
const broadcastController = require('../controllers/broadcastController');

const router = Router();

router.post('/', broadcastController.create);
router.get('/', broadcastController.list);
router.get('/:id', broadcastController.detail);
router.post('/:id/cancel', broadcastController.cancel);

module.exports = router;
