'use strict';

const { Router } = require('express');
const templateController = require('../controllers/templateController');

const router = Router();

router.get('/', templateController.list);
router.post('/', templateController.create);
router.get('/:id', templateController.get);
router.put('/:id', templateController.update);
router.delete('/:id', templateController.remove);

module.exports = router;
