import { Command, Event, Kafka, Task } from '@melonade/melonade-declaration';
import { AdminClient, KafkaConsumer, Producer } from 'node-rdkafka';
import * as R from 'ramda';
import * as config from '../config';
import { jsonTryParse } from '../utils/common';

export enum TimerInstanceTypes {
  Delay = 'DELAY',
  Timeout = 'TIMEOUT',
  AckTimeout = 'ACK_TIMEOUT',
  Complete = 'COMPLETE',
}

interface IBaseTimer {
  scheduledAt: number;
}

export interface ITimerDelayEvent extends IBaseTimer {
  task: Task.ITask;
  type: TimerInstanceTypes.Delay;
}

export interface ITimerAcktimeoutEvent extends IBaseTimer {
  taskId: string;
  transactionId: string;
  type: TimerInstanceTypes.AckTimeout;
}

export interface ITimerTimeoutEvent extends IBaseTimer {
  taskId: string;
  transactionId: string;
  type: TimerInstanceTypes.Timeout;
}

export interface ITimerCompleteEvent extends IBaseTimer {
  taskId: string;
  transactionId: string;
  type: TimerInstanceTypes.Complete;
}

export type AllTimerEvents =
  | ITimerDelayEvent
  | ITimerAcktimeoutEvent
  | ITimerTimeoutEvent
  | ITimerCompleteEvent;

export const adminClient = AdminClient.create(config.kafkaAdminConfig);

export const consumerTasksClient = new KafkaConsumer(
  config.kafkaTaskWatcherConfig.config,
  config.kafkaTaskWatcherConfig.topic,
);

export const consumerTimerClient = new KafkaConsumer(
  config.kafkaTaskWatcherConfig.config,
  config.kafkaTaskWatcherConfig.topic,
);

export const consumerDelaysClients = config.DELAY_TOPIC_STATES.map(
  (delay: number) => {
    const consumer = new KafkaConsumer(
      {
        ...config.kafkaTaskWatcherConfig.config,
        'max.poll.interval.ms': Math.max(delay * 5, 30000),
      },
      config.kafkaTaskWatcherConfig.topic,
    );

    consumer.setDefaultConsumeTimeout(5);
    consumer.connect();
    return consumer;
  },
);

for (
  let clintNumber = 0;
  clintNumber < config.DELAY_TOPIC_STATES.length;
  clintNumber++
) {
  const consumerDelaysClient = consumerDelaysClients[clintNumber];
  consumerDelaysClient.on('ready', async () => {
    console.log(
      `Consumer Delay ${config.DELAY_TOPIC_STATES[clintNumber]} kafka are ready`,
    );
    const topicName = `${config.kafkaTopicName.timer}-${config.DELAY_TOPIC_STATES[clintNumber]}`;
    try {
      await createTopic(
        topicName,
        config.kafkaTopic.num_partitions,
        config.kafkaTopic.replication_factor,
      );
    } catch (error) {
      console.warn(`Create topic "${topicName}" error: ${error.toString()}`);
    } finally {
      consumerDelaysClient.subscribe([topicName]);
    }
  });
}

export const producerClient = new Producer(
  config.kafkaProducerConfig.config,
  config.kafkaProducerConfig.topic,
);

consumerTasksClient.setDefaultConsumeTimeout(5);
consumerTasksClient.connect();
consumerTasksClient.on('ready', () => {
  console.log('Consumer Tasks kafka are ready');
  consumerTasksClient.subscribe([
    // Internal lib already support Regexp
    new RegExp(`^${config.kafkaTopicName.task}.*`) as any,
  ]);
});

consumerTimerClient.setDefaultConsumeTimeout(5);
consumerTimerClient.connect();
consumerTimerClient.on('ready', async () => {
  console.log('Consumer Timer kafka are ready');
  try {
    await createTopic(
      config.kafkaTopicName.timer,
      config.kafkaTopic.num_partitions,
      config.kafkaTopic.replication_factor,
    );
  } catch (error) {
    console.warn(
      `Create topic "${
        config.kafkaTopicName.timer
      }" error: ${error.toString()}`,
    );
  } finally {
    consumerTimerClient.subscribe([config.kafkaTopicName.timer]);
  }
});

producerClient.connect();
producerClient.setPollInterval(100);
producerClient.on('ready', () => {
  console.log('Producer kafka are ready');
});

export const createTopic = (
  topicName: string,
  numPartitions: number,
  replicationFactor: number,
  config?: any,
): Promise<any> =>
  new Promise((resolve: Function, reject: Function) => {
    adminClient.createTopic(
      {
        topic: topicName,
        num_partitions: numPartitions,
        replication_factor: replicationFactor,
        config: {
          'cleanup.policy': 'delete',
          'compression.type': 'snappy',
          'retention.ms': '604800000', // '604800000' 7 days // '2592000000' 30 days
          'unclean.leader.election.enable': 'false',
          ...config,
        },
      },
      (error: Error, data: any) => {
        if (error) return reject(error);
        resolve(data);
      },
    );
  });

export const poll = (
  consumer: KafkaConsumer,
  messageNumber: number = 100,
): Promise<any[]> =>
  new Promise((resolve: Function, reject: Function) => {
    consumer.consume(
      messageNumber,
      (error: Error, messages: Kafka.kafkaConsumerMessage[]) => {
        if (error) return reject(error);
        resolve(
          messages.map((message: Kafka.kafkaConsumerMessage) =>
            jsonTryParse(message.value.toString(), {}),
          ),
        );
      },
    );
  });

const findFitDelay = (timeBeforeSchedule: number) => {
  const matchDelay = R.findLast(
    (delay: number) => delay <= timeBeforeSchedule,
    config.DELAY_TOPIC_STATES,
  );

  if (matchDelay) {
    return matchDelay;
  } else {
    return config.DELAY_TOPIC_STATES[0];
  }
};

const getEventTransactionId = (timerEvent: AllTimerEvents): string => {
  switch (timerEvent.type) {
    case TimerInstanceTypes.Delay:
      return timerEvent.task.transactionId;
    case TimerInstanceTypes.AckTimeout:
    case TimerInstanceTypes.Timeout:
    case TimerInstanceTypes.Complete:
    default:
      return timerEvent.transactionId;
  }
};

export const delayTimer = (timerEvent: AllTimerEvents) => {
  producerClient.produce(
    `${config.kafkaTopicName.timer}-${findFitDelay(
      timerEvent.scheduledAt - Date.now(),
    )}`,
    null,
    Buffer.from(JSON.stringify(timerEvent)),
    getEventTransactionId(timerEvent),
    Date.now(),
  );

  switch (timerEvent.type) {
    case TimerInstanceTypes.Complete:
    case TimerInstanceTypes.AckTimeout:
    case TimerInstanceTypes.Timeout:
      console.log(
        `Set next schedule of "${timerEvent.taskId}" (${
          timerEvent.type
        }) to ${timerEvent.scheduledAt - Date.now()}ms`,
      );
      break;

    default:
      break;
  }
};

export const updateTask = (taskUpdate: Event.ITaskUpdate) => {
  producerClient.produce(
    config.kafkaTopicName.event,
    null,
    Buffer.from(JSON.stringify(taskUpdate)),
    taskUpdate.transactionId,
    Date.now(),
  );

  console.log(`Update "${taskUpdate.taskId}" to ${taskUpdate.status}`);
};

export const reloadTask = (task: Task.ITask) => {
  producerClient.produce(
    config.kafkaTopicName.command,
    null,
    Buffer.from(
      JSON.stringify(<Command.IReloadTaskCommand>{
        type: Command.CommandTypes.ReloadTask,
        transactionId: task.transactionId,
        task,
      }),
    ),
    task.transactionId,
    Date.now(),
  );
  console.log(`Restart "${task.taskId}"`);
};
