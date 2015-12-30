'use strict';

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var uuid = require('node-uuid');
var queue = require('queue-async');

function JobBackend(metadataBackend, jobQueueProducer, jobPublisher, userIndexer) {
    EventEmitter.call(this);
    this.metadataBackend = metadataBackend;
    this.jobQueueProducer = jobQueueProducer;
    this.jobPublisher = jobPublisher;
    this.userIndexer = userIndexer;
    this.db = 5;
    this.redisPrefix = 'batch:jobs:';
}
util.inherits(JobBackend, EventEmitter);

JobBackend.prototype.create = function (username, sql, host, callback) {
    var self = this;
    var job_id = uuid.v4();
    var now = new Date().toISOString();
    var redisParams = [
        this.redisPrefix + job_id,
        'user', username,
        'status', 'pending',
        'query', sql,
        'created_at', now,
        'updated_at', now
    ];

    this.metadataBackend.redisCmd(this.db, 'HMSET', redisParams , function (err) {
        if (err) {
            return callback(err);
        }

        self.jobQueueProducer.enqueue(job_id, host, function (err) {
            if (err) {
                return callback(err);
            }

            // broadcast to consumers
            self.jobPublisher.publish(host);

            self.userIndexer.add(username, job_id, function (err) {
              if (err) {
                  return callback(err);
              }

              self.get(job_id, callback);
            });
        });
    });
};

JobBackend.prototype.list = function (username, callback) {
    var self = this;
    this.userIndexer.list(username, function (err, job_ids) {
        if (err) {
            return callback(err);
        }

        var jobsQueue = queue(job_ids.length);

        job_ids.forEach(function(job_id) {
            jobsQueue.defer(self.get.bind(self), job_id);
        });

        jobsQueue.awaitAll(function (err, jobs) {
            if (err) {
                return callback(err);
            }
            callback(null, jobs);
        });
    });
};

JobBackend.prototype.get = function (job_id, callback) {
    var redisParams = [
        this.redisPrefix + job_id,
        'user',
        'status',
        'query',
        'created_at',
        'updated_at',
        'failed_reason'
    ];

    this.metadataBackend.redisCmd(this.db, 'HMGET', redisParams , function (err, jobValues) {
        if (err) {
            return callback(err);
        }

        function isJobFound(jobValues) {
            return jobValues[0] && jobValues[1] && jobValues[2] && jobValues[3] && jobValues[4];
        }

        if (!isJobFound(jobValues)) {
            return callback(new Error('Job with id ' + job_id + ' not found'));
        }

        callback(null, {
            job_id: job_id,
            user: jobValues[0],
            status: jobValues[1],
            query: jobValues[2],
            created_at: jobValues[3],
            updated_at: jobValues[4],
            failed_reason: jobValues[5] ? jobValues[5] : undefined
        });
    });
};

JobBackend.prototype.setRunning = function (job) {
    var self = this;
    var redisParams = [
        this.redisPrefix + job.job_id,
        'status', 'running',
        'updated_at', new Date().toISOString()
    ];

    this.metadataBackend.redisCmd(this.db, 'HMSET', redisParams, function (err) {
        if (err) {
            return self.emit('error', err);
        }

        self.emit('running', job);
    });
};

JobBackend.prototype.setDone = function (job) {
    var self = this;
    var redisParams = [
        this.redisPrefix + job.job_id,
        'status', 'done',
        'updated_at', new Date().toISOString()
    ];

    this.metadataBackend.redisCmd(this.db, 'HMSET', redisParams ,  function (err) {
        if (err) {
            return self.emit('error', err);
        }

        self.emit('done', job);
    });
};

JobBackend.prototype.setFailed = function (job, err) {
    var self = this;
    var redisParams = [
        this.redisPrefix + job.job_id,
        'status', 'failed',
        'failed_reason', err.message,
        'updated_at', new Date().toISOString()
    ];

    this.metadataBackend.redisCmd(this.db, 'HMSET', redisParams , function (err) {
        if (err) {
            return self.emit('error', err);
        }

        self.emit('failed', job);
    });
};

JobBackend.prototype.setCancelled = function (job) {
    var self = this;
    var redisParams = [
        this.redisPrefix + job.job_id,
        'status', 'cancelled',
        'updated_at', new Date().toISOString()
    ];

    this.metadataBackend.redisCmd(this.db, 'HMSET', redisParams ,  function (err) {
        if (err) {
            return self.emit('error', err);
        }

        self.emit('cancelled', job);
    });
};


module.exports = JobBackend;
