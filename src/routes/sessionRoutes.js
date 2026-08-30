'use strict';

const { Router } = require('express');
const sessionController = require('../controllers/sessionController');

const router = Router();

router.get('/', sessionController.list);
router.post('/', sessionController.add);
router.get('/:id/status', sessionController.status);
router.patch('/:id', sessionController.rename);
router.delete('/:id', sessionController.remove);
router.post('/:id/rescan', sessionController.rescan);
router.post('/:id/logout', sessionController.logout);

module.exports = router;
