import * as winston from 'winston';

export class Logger {
  private logger: winston.Logger;

  constructor(label: string = 'EventFlow') {
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.metadata(),
        winston.format.json()
      ),
      defaultMeta: { service: label },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ level, message, timestamp }) => {
              return `[${timestamp}] ${level}: ${message}`;
            })
          )
        })
      ]
    });

    if (process.env.NODE_ENV === 'production') {
      this.logger.add(
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' })
      );
      this.logger.add(
        new winston.transports.File({ filename: 'logs/combined.log' })
      );
    }
  }

  info(message: string, meta?: any) {
    this.logger.info(message, meta);
  }

  error(message: string, meta?: any) {
    this.logger.error(message, meta);
  }

  warn(message: string, meta?: any) {
    this.logger.warn(message, meta);
  }

  debug(message: string, meta?: any) {
    this.logger.debug(message, meta);
  }
}
