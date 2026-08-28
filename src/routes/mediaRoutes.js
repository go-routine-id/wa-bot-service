'use strict';

const { Router } = require('express');
const mediaController = require('../controllers/mediaController');
const { uploadSingleImage } = require('../middleware/upload');

const router = Router();

router.post('/', uploadSingleImage('image'), mediaController.upload);
router.delete('/', mediaController.remove);

module.exports = router;
