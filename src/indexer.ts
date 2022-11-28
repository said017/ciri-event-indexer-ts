import {
  credentials,
  NodeClient,
  proto,
  hexToBuffer,
  bufferToHex,
} from "@apibara/protocol";
import { Block, Transaction, TransactionReceipt } from "@apibara/starknet";
import BN from "bn.js";
import { getSelectorFromName } from "starknet/dist/utils/hash";
import { EntityManager } from "typeorm";
import { AppDataSource } from "./data-source";
import { State, Token, Transfer, ProfileCreated } from "./entities";

const CIRI_DEPLOY_BLOCK = 436_119;
const CIRI_ADDRESS = hexToBuffer(
  "0x022da370305a2281f811c7c9ff4d9ec75f8acf5e0b15adbc589bcc99a6b2eca7",
  32
);
const TRANSFER_KEY = hexToBuffer(getSelectorFromName("user_created"), 32);

export class AppIndexer {
  private readonly client: NodeClient;
  private readonly indexerId: string;

  constructor(indexerId: string, url: string) {
    this.indexerId = indexerId;
    this.client = new NodeClient(url, credentials.createSsl());
  }

  async run() {
    // resume from where it left the previous run
    // const state = await AppDataSource.manager.findOneBy(State, {
    //   indexerId: this.indexerId,
    // });
    let startingSequence = CIRI_DEPLOY_BLOCK;
    // if (state) {
    //   startingSequence = state.sequence + 1;
    // }

    const messages = this.client.streamMessages({
      startingSequence,
    });

    messages.on("data", this.handleData.bind(this));

    // keep running until the stream finishes
    return new Promise((resolve, reject) => {
      messages.on("end", resolve);
      messages.on("error", reject);
    });
  }

  async handleData(message: proto.StreamMessagesResponse__Output) {
    if (message.data) {
      if (!message.data.data.value) {
        throw new Error("received invalid data");
      }
      const block = Block.decode(message.data.data.value);
      await this.handleBlock(block);
    } else if (message.invalidate) {
      console.log(message.invalidate);
    }
  }

  async handleBlock(block: Block) {
    console.log("Block");
    console.log(`    hash: ${bufferToHex(new Buffer(block.blockHash.hash))}`);
    console.log(`  number: ${block.blockNumber}`);
    console.log(`    time: ${block.timestamp.toISOString()}`);

    // console.log("  transfers");
    await AppDataSource.manager.transaction(async (manager) => {
      for (let receipt of block.transactionReceipts) {
        const tx = block.transactions[receipt.transactionIndex];
        await this.handleTransaction(manager, tx, receipt);
      }

      // updated indexed block
      await manager.upsert(
        State,
        { indexerId: this.indexerId, sequence: block.blockNumber },
        { conflictPaths: ["indexerId"] }
      );
    });
  }

  async handleTransaction(
    manager: EntityManager,
    tx: Transaction,
    receipt: TransactionReceipt
  ) {
    for (let event of receipt.events) {
      if (!CIRI_ADDRESS.equals(event.fromAddress)) {
        continue;
      }
      if (!TRANSFER_KEY.equals(event.keys[0])) {
        continue;
      }
      console.log("go to created event")
      console.log(event.data)

      const account = uint256FromBytes(
        Buffer.from(event.data[0]),
        Buffer.from(event.data[1])
      );
      const name = Buffer.from(event.data[2]);

      await manager.insert(
        ProfileCreated,
        {  account: account.toBuffer(), name: name, }
      );
    }
  }
}

function uint256FromBytes(low: Buffer, high: Buffer): BN {
  const lowB = new BN(low);
  const highB = new BN(high);
  return highB.shln(128).add(lowB);
}
