import { CfnTable } from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { Column } from './schema';
import { PartitionIndex, TableBase, TableBaseProps } from './table-base';
import { addConstructMetadata } from 'aws-cdk-lib/core/lib/metadata-resource';

/**
 * Encryption options for a Table.
 *
 * @see https://docs.aws.amazon.com/athena/latest/ug/encryption.html
 */
export enum TableEncryption {
  /**
   * Server side encryption (SSE) with an Amazon S3-managed key.
   *
   * @see https://docs.aws.amazon.com/AmazonS3/latest/dev/UsingServerSideEncryption.html
   */
  S3_MANAGED = 'SSE-S3',

  /**
   * Server-side encryption (SSE) with an AWS KMS key managed by the account owner.
   *
   * @see https://docs.aws.amazon.com/AmazonS3/latest/dev/UsingKMSEncryption.html
   */
  KMS = 'SSE-KMS',

  /**
   * Server-side encryption (SSE) with an AWS KMS key managed by the KMS service.
   */
  KMS_MANAGED = 'SSE-KMS-MANAGED',

  /**
   * Client-side encryption (CSE) with an AWS KMS key managed by the account owner.
   *
   * @see https://docs.aws.amazon.com/AmazonS3/latest/dev/UsingClientSideEncryption.html
   */
  CLIENT_SIDE_KMS = 'CSE-KMS',
}

export interface S3TableProps extends TableBaseProps {
  /**
   * S3 bucket in which to store data.
   *
   * @default one is created for you
   */
  readonly bucket?: s3.IBucket;

  /**
   * S3 prefix under which table objects are stored.
   *
   * @default - No prefix. The data will be stored under the root of the bucket.
   */
  readonly s3Prefix?: string;

  /**
   * The kind of encryption to secure the data with.
   *
   * You can only provide this option if you are not explicitly passing in a bucket.
   *
   * If you choose `SSE-KMS`, you *can* provide an un-managed KMS key with `encryptionKey`.
   * If you choose `CSE-KMS`, you *must* provide an un-managed KMS key with `encryptionKey`.
   *
   * @default BucketEncryption.S3_MANAGED
   */
  readonly encryption?: TableEncryption;

  /**
   * External KMS key to use for bucket encryption.
   *
   * The `encryption` property must be `SSE-KMS` or `CSE-KMS`.
   *
   * @default key is managed by KMS.
   */
  readonly encryptionKey?: kms.IKey;
}

/**
 * A Glue table that targets a S3 dataset.
 * @resource AWS::Glue::Table
 */
export class S3Table extends TableBase {
  /**
   * Name of this table.
   */
  public readonly tableName: string;

  /**
   * ARN of this table.
   */
  public readonly tableArn: string;

  /**
   * S3 bucket in which the table's data resides.
   */
  public readonly bucket: s3.IBucket;

  /**
   * S3 Key Prefix under which this table's files are stored in S3.
   */
  public readonly s3Prefix: string;

  /**
   * The type of encryption enabled for the table.
   */
  public readonly encryption: TableEncryption;

  /**
   * The KMS key used to secure the data if `encryption` is set to `CSE-KMS` or `SSE-KMS`. Otherwise, `undefined`.
   */
  public readonly encryptionKey?: kms.IKey;

  /**
   * This table's partition indexes.
   */
  public readonly partitionIndexes?: PartitionIndex[];

  protected readonly tableResource: CfnTable;

  constructor(scope: Construct, id: string, props: S3TableProps) {
    super(scope, id, props);
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);
    this.s3Prefix = props.s3Prefix ?? '';
    const { bucket, encryption, encryptionKey } = createBucket(this, props);
    this.bucket = bucket;
    this.encryption = encryption;
    this.encryptionKey = encryptionKey;

    this.tableResource = new CfnTable(this, 'Table', {
      catalogId: props.database.catalogId,

      databaseName: props.database.databaseName,

      tableInput: {
        name: this.physicalName,
        description: props.description || `${this.physicalName} generated by CDK`,

        partitionKeys: renderColumns(props.partitionKeys),

        parameters: {
          'classification': props.dataFormat.classificationString?.value,
          'has_encrypted_data': true,
          'partition_filtering.enabled': props.enablePartitionFiltering,
          ...this.parameters,
        },
        storageDescriptor: {
          location: `s3://${this.bucket.bucketName}/${this.s3Prefix}`,
          compressed: this.compressed,
          storedAsSubDirectories: props.storedAsSubDirectories ?? false,
          columns: renderColumns(props.columns),
          inputFormat: props.dataFormat.inputFormat.className,
          outputFormat: props.dataFormat.outputFormat.className,
          serdeInfo: {
            serializationLibrary: props.dataFormat.serializationLibrary.className,
          },
          parameters: props.storageParameters ? props.storageParameters.reduce((acc, param) => {
            if (param.key in acc) {
              throw new Error(`Duplicate storage parameter key: ${param.key}`);
            }
            const key = param.key;
            acc[key] = param.value;
            return acc;
          }, {} as { [key: string]: string }) : undefined,
        },

        tableType: 'EXTERNAL_TABLE',
      },
    });

    this.tableName = this.getResourceNameAttribute(this.tableResource.ref);
    this.tableArn = this.stack.formatArn({
      service: 'glue',
      resource: 'table',
      resourceName: `${this.database.databaseName}/${this.tableName}`,
    });
    this.node.defaultChild = this.tableResource;

    // Partition index creation relies on created table.
    if (props.partitionIndexes) {
      this.partitionIndexes = props.partitionIndexes;
      this.partitionIndexes.forEach((index) => this.addPartitionIndex(index));
    }
  }

  /**
   * Grant read permissions to the table and the underlying data stored in S3 to an IAM principal.
   *
   * @param grantee the principal
   */
  public grantRead(grantee: iam.IGrantable): iam.Grant {
    const ret = this.grant(grantee, readPermissions);
    if (this.encryptionKey && this.encryption === TableEncryption.CLIENT_SIDE_KMS) { this.encryptionKey.grantDecrypt(grantee); }
    this.bucket.grantRead(grantee, this.generateS3PrefixForGrant());
    return ret;
  }

  /**
   * Grant write permissions to the table and the underlying data stored in S3 to an IAM principal.
   *
   * @param grantee the principal
   */
  public grantWrite(grantee: iam.IGrantable): iam.Grant {
    const ret = this.grant(grantee, writePermissions);
    if (this.encryptionKey && this.encryption === TableEncryption.CLIENT_SIDE_KMS) { this.encryptionKey.grantEncrypt(grantee); }
    this.bucket.grantWrite(grantee, this.generateS3PrefixForGrant());
    return ret;
  }

  /**
   * Grant read and write permissions to the table and the underlying data stored in S3 to an IAM principal.
   *
   * @param grantee the principal
   */
  public grantReadWrite(grantee: iam.IGrantable): iam.Grant {
    const ret = this.grant(grantee, [...readPermissions, ...writePermissions]);
    if (this.encryptionKey && this.encryption === TableEncryption.CLIENT_SIDE_KMS) { this.encryptionKey.grantEncryptDecrypt(grantee); }
    this.bucket.grantReadWrite(grantee, this.generateS3PrefixForGrant());
    return ret;
  }

  protected generateS3PrefixForGrant() {
    return this.s3Prefix + '*';
  }
}

const readPermissions = [
  'glue:BatchGetPartition',
  'glue:GetPartition',
  'glue:GetPartitions',
  'glue:GetTable',
  'glue:GetTables',
  'glue:GetTableVersion',
  'glue:GetTableVersions',
];

const writePermissions = [
  'glue:BatchCreatePartition',
  'glue:BatchDeletePartition',
  'glue:CreatePartition',
  'glue:DeletePartition',
  'glue:UpdatePartition',
];

// map TableEncryption to bucket's SSE configuration (s3.BucketEncryption)
const encryptionMappings = {
  [TableEncryption.S3_MANAGED]: s3.BucketEncryption.S3_MANAGED,
  [TableEncryption.KMS_MANAGED]: s3.BucketEncryption.KMS_MANAGED,
  [TableEncryption.KMS]: s3.BucketEncryption.KMS,
  [TableEncryption.CLIENT_SIDE_KMS]: s3.BucketEncryption.S3_MANAGED,
};

// create the bucket to store a table's data depending on the `encryption` and `encryptionKey` properties.
function createBucket(table: S3Table, props: S3TableProps) {
  let bucket = props.bucket;

  if (bucket && (props.encryption !== undefined && props.encryption !== TableEncryption.CLIENT_SIDE_KMS)) {
    throw new Error('you can not specify encryption settings if you also provide a bucket');
  }

  const encryption = props.encryption || TableEncryption.S3_MANAGED;

  let encryptionKey: kms.IKey | undefined;
  if (encryption === TableEncryption.CLIENT_SIDE_KMS && props.encryptionKey === undefined) {
    // CSE-KMS should behave the same as SSE-KMS - use the provided key or create one automatically
    // Since Bucket only knows about SSE, we repeat the logic for CSE-KMS at the Table level.
    encryptionKey = new kms.Key(table, 'Key');
  } else {
    encryptionKey = props.encryptionKey;
  }

  // create the bucket if none was provided
  if (!bucket) {
    if (encryption === TableEncryption.CLIENT_SIDE_KMS) {
      bucket = new s3.Bucket(table, 'Bucket');
    } else {
      bucket = new s3.Bucket(table, 'Bucket', {
        encryption: encryptionMappings[encryption],
        encryptionKey,
      });
      encryptionKey = bucket.encryptionKey;
    }
  }

  return {
    bucket,
    encryption,
    encryptionKey,
  };
}

function renderColumns(columns?: Array<Column | Column>) {
  if (columns === undefined) {
    return undefined;
  }
  return columns.map(column => {
    return {
      name: column.name,
      type: column.type.inputString,
      comment: column.comment,
    };
  });
}
