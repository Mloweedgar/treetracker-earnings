const Joi = require('joi');
const { Parser } = require('json2csv');
const csv = require('csvtojson');
const fs = require('fs').promises;
const { v4: uuid } = require('uuid');

const { upload_csv } = require('../services/aws');
const Session = require('../models/Session');
const EarningsRepository = require('../repositories/EarningsRepository');
const {
  getEarnings,
  updateEarnings,
  getBatchEarnings,
} = require('../models/Earnings');
const HttpError = require('../utils/HttpError');

const earningsGetQuerySchema = Joi.object({
  earnings_status: Joi.string(),
  organization: Joi.string(),
  planter_id: Joi.string(),
  contract_id: Joi.string(),
  start_date: Joi.date().iso(),
  end_date: Joi.date().iso(),
  limit: Joi.number().integer().greater(0).less(101),
  offset: Joi.number().integer().greater(-1),
}).unknown(false);

const earningsPatchSchema = Joi.object({
  id: Joi.string().uuid().required(),
  worker_id: Joi.string().uuid().required(),
  amount: Joi.number().required(),
  currency: Joi.string().required(),
  payment_confirmation_id: Joi.string().required(),
  payment_system: Joi.string().required(),
  paid_at: Joi.date().iso(),
});

const earningsBatchPatchSchema = Joi.object({
  earnings_id: Joi.string().uuid().required(),
  worker_id: Joi.string().uuid().required(),
  amount: Joi.number().required(),
  currency: Joi.string().required(),
  payment_confirmation_id: Joi.string().required(),
  payment_system: Joi.string().required(),
  paid_at: Joi.date().iso(),
  phone: Joi.string().required(),
});

const earningsGet = async (req, res, next) => {
  await earningsGetQuerySchema.validateAsync(req.query, { abortEarly: false });
  const session = new Session();
  const earningsRepo = new EarningsRepository(session);

  const url = `${req.protocol}://${req.get('host')}/message?author_handle=${
    req.query.author_handle
  }`;

  const executeGetEarnings = getEarnings(earningsRepo);
  const result = await executeGetEarnings(req.query, url);
  res.send(result);
  res.end();
};

const earningsPatch = async (req, res, next) => {
  await earningsPatchSchema.validateAsync(req.body, { abortEarly: false });
  const session = new Session();
  const earningsRepo = new EarningsRepository(session);

  try {
    await session.beginTransaction();
    const result = await updateEarnings(earningsRepo, req.body);
    await session.commitTransaction();
    res.status(200).send(result);
    res.end();
  } catch (e) {
    console.log(e);
    if (session.isTransactionInProgress()) {
      await session.rollbackTransaction();
    }
    next(e);
  }
};

const earningsBatchGet = async (req, res, next) => {
  await earningsGetQuerySchema.validateAsync(req.query, { abortEarly: false });
  const session = new Session();
  const earningsRepo = new EarningsRepository(session);

  const executeGetBatchEarnings = getBatchEarnings(earningsRepo);
  const result = await executeGetBatchEarnings(req.query);
  const json2csv = new Parser();
  const csv = json2csv.parse(result.earnings);
  res.header('Content-Type', 'text/csv');
  res.attachment('batchEarnings.csv');
  res.send(csv);
  res.end();
};

const earningsBatchPatch = async (req, res, next) => {
  if (req.file.mimetype !== 'text/csv')
    throw new HttpError(406, 'Only text/csv is supported');

  const key = `treetracker_earnings/${uuid()}.csv`;
  const fileBuffer = await fs.readFile(req.file.path);
  await upload_csv(fileBuffer, key);
  const session = new Session();
  const earningsRepo = new EarningsRepository(session);
  try {
    const jsonArray = await csv().fromFile(req.file.path);
    let count = 0;
    await session.beginTransaction();
    for (const row of jsonArray) {
      await earningsBatchPatchSchema.validateAsync(row, { abortEarly: false });
      await updateEarnings(earningsRepo, row);
      count++;
    }
    // delete temp file
    await fs.unlink(req.file.path);
    await session.commitTransaction();
    res.status(200).send({
      status: 'completed',
      count,
    });
    res.end();
  } catch (e) {
    console.log(e);
    if (session.isTransactionInProgress()) {
      await session.rollbackTransaction();
    }
    // delete temp file
    await fs.unlink(req.file.path);
    next(e);
  }
};

module.exports = {
  earningsGet,
  earningsPatch,
  earningsBatchGet,
  earningsBatchPatch,
};
