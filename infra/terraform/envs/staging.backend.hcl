# terraform init -backend-config=envs/staging.backend.hcl
# Create the bucket and table once, by hand, before the first init:
#   aws s3api create-bucket --bucket alke-terraform-state --region af-south-1 \
#     --create-bucket-configuration LocationConstraint=af-south-1
#   aws s3api put-bucket-versioning --bucket alke-terraform-state --versioning-configuration Status=Enabled
#   aws dynamodb create-table --table-name alke-terraform-locks --region af-south-1 \
#     --attribute-definitions AttributeName=LockID,AttributeType=S \
#     --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST
bucket         = "alke-terraform-state"
key            = "staging/platform.tfstate"
region         = "af-south-1"
dynamodb_table = "alke-terraform-locks"
encrypt        = true
