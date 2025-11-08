import {
  MongoDBContainer,
  StartedMongoDBContainer,
} from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';
import { Maybe } from '../src/types';

process.env.DOCKER_HOST = `unix://${process.env.HOME}/.colima/default/docker.sock`;
process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = '/var/run/docker.sock';

class MongoFixture {
  private readonly container = new MongoDBContainer('mongo:7.0');

  private started: Maybe<StartedMongoDBContainer>;
  private mongoClient: Maybe<MongoClient>;

  public get client(): MongoClient {
    if (this.mongoClient) {
      return this.mongoClient;
    }
    throw new Error('client not available, you need to run setup first');
  }

  public get connectionString(): string {
    if (this.started) {
      return getConnectionString(this.started);
    }
    throw new Error('mongo container not started, you need to run setup first');
  }

  public async setup() {
    if (!this.started) {
      this.started = await this.container.start();
      this.mongoClient = new MongoClient(getConnectionString(this.started));
      await this.mongoClient.connect();
    }
  }

  public async teardown() {
    if (this.mongoClient) {
      await this.mongoClient.close(true);
      this.mongoClient = undefined;
    }
    if (this.started) {
      await this.started.stop();
      this.started = undefined;
    }
  }
}

const fixture = new MongoFixture();
export const mongo = fixture as Omit<MongoFixture, 'setup' | 'teardown'>;
export const setupMongo = () => fixture.setup();
export const teardownMongo = () => fixture.teardown();

function getConnectionString(started: StartedMongoDBContainer) {
  const url = new URL(started.getConnectionString());
  url.searchParams.set('directConnection', 'true');
  return url.toString();
}
