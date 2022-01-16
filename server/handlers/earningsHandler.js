const Joi = require('joi');
const csv = require('csvtojson');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const { format } = require('@fast-csv/format');

const { BatchEarning } = require('../models/Earnings');
const { uploadCsv } = require('../services/aws');
const Session = require('../models/Session');
const EarningsRepository = require('../repositories/EarningsRepository');
const BatchRepository = require('../repositories/BatchRepository');
const {
  getEarnings,
  updateEarnings,
  getBatchEarnings,
} = require('../models/Earnings');
const HttpError = require('../utils/HttpError');

const earningsGetQuerySchema = Joi.object({
  earnings_status: Joi.string(),
  grower: Joi.string(),
  funder_id: Joi.string().uuid(),
  worker_id: Joi.string().uuid(),
  contract_id: Joi.string().uuid(),
  start_date: Joi.date().iso(),
  end_date: Joi.date().iso(),
  limit: Joi.number().integer().greater(0).less(101),
  offset: Joi.number().integer().greater(-1),
  sort_by: Joi.string().valid(
    'id',
    'grower',
    'funder',
    'amount',
    'payment_system',
    'effective_payment_date',
  ),
  order: Joi.string().valid('asc', 'desc'),
}).unknown(false);

const earningsPatchSchema = Joi.object({
  id: Joi.string().uuid(),
  earnings_id: Joi.string().uuid(),
  worker_id: Joi.string().uuid().required(),
  amount: Joi.number().required(),
  currency: Joi.string().required(),
  payment_confirmation_id: Joi.string(),
  payment_system: Joi.string(),
  paid_at: Joi.date().iso(),
  phone: Joi.string(),
}).xor('id', 'earnings_id');

const earningsGet = async (req, res) => {
  await earningsGetQuerySchema.validateAsync(req.query, { abortEarly: false });
  const session = new Session();
  const earningsRepo = new EarningsRepository(session);

  const url = `${req.protocol}://${req.get('host')}/earnings`;

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

const earningsBatchGet = async (req, res) => {
  await earningsGetQuerySchema.validateAsync(req.query, { abortEarly: false });
  const session = new Session();
  const earningsRepo = new EarningsRepository(session);

  try {
    const executeGetBatchEarnings = getBatchEarnings(earningsRepo);
    const { earningsStream } = await executeGetBatchEarnings(req.query);
    const csvStream = format({ headers: true });

    // using for await due to the async call that is made
    for await (const row of earningsStream) {
      const earningRow = await BatchEarning({ ...row });
      csvStream.write(earningRow);
    }

    csvStream.end();

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename=batchEarnings.csv',
    });
    csvStream.pipe(res).on('end', () => {});
  } catch (err) {
    console.error(err);
    throw new HttpError(422, err.message);
  }
};

const earningsBatchPatch = async (req, res, next) => {
  if (req.file.mimetype !== 'text/csv')
    throw new HttpError(406, 'Only text/csv is supported');

  const key = `treetracker_earnings/${new Date().toISOString()}_${uuid()}.csv`;
  const fileBuffer = await fs.promises.readFile(req.file.path);
  const csvReadStream = fs.createReadStream(req.file.path);
  console.log('file path---------', req.file.path)
  const session = new Session();
  // Don't want to roll back batch updates if system errors out
  const batchSession = new Session();
  const batchRepo = new BatchRepository(batchSession);
  const earningsRepo = new EarningsRepository(session);
  let batch_id = '';

  const batchUpdateEarnings = () => {
    let count = 0;
    return new Promise((resolve, reject) => {

      csv()
        .fromStream(csvReadStream)
        .subscribe(
          async (json) => {
            console.log('the json---------', json);
            // await earningsPatchSchema.validateAsync(json, {
            //   abortEarly: false,
            // });
            await updateEarnings(earningsRepo, {
              ...json,
            });
            count++;
          },
          function (e) {
            reject(e);
          },
          function () {
            resolve(count);
          },
        );
    });
  };
  try {
    // const uploadResult = await uploadCsv(fileBuffer, key);

    // const batch = await batchRepo.create({
    //   url: 'http://example.com/csv', // TODO: replace with actual url
    //   status: 'created',
    //   active: true,
    // });
    // batch_id = batch.id;

    await session.beginTransaction();

    const count = await batchUpdateEarnings();

    // delete temp file
    await fs.promises.unlink(req.file.path);

    // update batch status to completed
    // await batchRepo.update({ id: batch.id, status: 'completed' });

    await session.commitTransaction();
    res.status(200).send({
      status: 'completed',
      count,
    });
    res.end();
  } catch (e) {
    console.log(e);
    // update batch status to successful, if code errors out after batch was created
    if (batch_id) {
      await batchRepo.update({ id: batch_id, status: 'failed', active: false });
    }
    if (session.isTransactionInProgress()) {
      await session.rollbackTransaction();
    }
    // delete temp file
    await fs.promises.unlink(req.file.path);

    next(e);
  }
};

module.exports = {
  earningsGet,
  earningsPatch,
  earningsBatchGet,
  earningsBatchPatch,
};
